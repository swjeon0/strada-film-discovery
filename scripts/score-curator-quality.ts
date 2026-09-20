import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  QUALITY_AXIS_KEYS,
  QUALITY_CONDITIONS,
  type QualityCondition,
} from "./evaluate-curator-quality";

const HELP = `Score completed human STRADA quality packets

npm run score:curator-quality -- --report work/curator-quality.json --ratings reviewer-1.json,reviewer-2.json,reviewer-3.json --out work/curator-quality-human-score.json

--report FILE.json     Raw report containing the private A/B condition map
--ratings F1,F2,F3     Three or more independently completed human rating files
--out FILE.json        Optional score report; never overwritten
--help                 Show this help

LLM-authored rating files are rejected. LLM judges are development proxies only.
`;

const AxisScoresSchema = z.object({
  setReading: z.number().min(1).max(5),
  specificity: z.number().min(1).max(5),
  discoveryValue: z.number().min(1).max(5),
  curatorialJudgment: z.number().min(1).max(5),
  listComposition: z.number().min(1).max(5),
  trustworthiness: z.number().min(1).max(5),
});
const ListRatingSchema = z.object({
  axes: AxisScoresSchema,
  overallUsefulness: z.number().min(1).max(5),
  items: z
    .array(
      z.object({
        rank: z.number().int().min(1).max(12),
        verdict: z.enum(["strong", "useful", "weak", "reject", "unrated"]),
        notes: z.string(),
      }),
    )
    .length(12),
  criticalErrors: z.array(z.string()),
  notes: z.string(),
});
const HumanRatingSchema = z.object({
  version: z.literal(2),
  packetId: z.string(),
  evaluatorType: z.literal("human"),
  reviewerId: z.string().min(1),
  cases: z
    .array(
      z.object({
        comparisonId: z.string(),
        caseId: z.string(),
        repetition: z.number().int().positive(),
        seedFamiliarity: z.number().min(1).max(5),
        ratings: z.object({ A: ListRatingSchema, B: ListRatingSchema }),
        preferred: z.enum(["A", "B", "tie"]),
        confidence: z.number().min(1).max(5),
        pairwiseRationale: z.string(),
      }),
    )
    .min(1),
});
const ReportSchema = z.object({
  version: z.literal(2),
  packetId: z.string(),
  blindConditionMap: z.record(
    z.string(),
    z.object({ A: z.enum(QUALITY_CONDITIONS), B: z.enum(QUALITY_CONDITIONS) }),
  ),
});
type HumanRating = z.infer<typeof HumanRatingSchema>;

export type ScoreOptions = {
  help: boolean;
  report: string;
  ratings: string[];
  out?: string;
};
export function parseScoreOptions(argv: string[]): ScoreOptions {
  const values: Record<string, string> = {},
    switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--"))
      throw new Error("Use named options; see --help.");
    const name = argv[i].slice(2);
    if (name === "help") {
      switches.add(name);
      continue;
    }
    if (
      !["report", "ratings", "out"].includes(name) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw new Error("Unknown option or missing value; see --help.");
    values[name] = argv[++i];
  }
  if (switches.has("help")) return { help: true, report: "", ratings: [] };
  if (!values.report || !values.ratings)
    throw new Error("--report and --ratings are required.");
  const ratings = values.ratings
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ratings.length < 3)
    throw new Error("At least three human rating files are required.");
  if (values.out && !values.out.endsWith(".json"))
    throw new Error("--out must be a .json file.");
  return { help: false, report: values.report, ratings, out: values.out };
}

const mean = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
function wilsonInterval(successes: number, total: number, z = 1.96) {
  if (!total) return { low: 0, high: 1 };
  const p = successes / total,
    z2 = z * z,
    denominator = 1 + z2 / total,
    centre = (p + z2 / (2 * total)) / denominator,
    margin =
      (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return {
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

export function scoreHumanRatings(rawReport: unknown, rawRatings: unknown[]) {
  const report = ReportSchema.parse(rawReport),
    ratings = rawRatings.map((item) => HumanRatingSchema.parse(item));
  const reviewerIds = ratings.map((item) => item.reviewerId);
  if (new Set(reviewerIds).size !== reviewerIds.length)
    throw new Error("reviewerId values must be unique.");
  if (ratings.some((item) => item.packetId !== report.packetId))
    throw new Error("Every rating file must match the report packetId.");
  const expected = Object.keys(report.blindConditionMap).sort();
  for (const rating of ratings) {
    const actual = rating.cases.map((item) => item.comparisonId).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `Reviewer ${rating.reviewerId} did not rate every comparison exactly once.`,
      );
  }

  const byComparison = new Map<string, HumanRating["cases"]>();
  for (const comparison of expected)
    byComparison.set(
      comparison,
      ratings.map(
        (rating) =>
          rating.cases.find((item) => item.comparisonId === comparison)!,
      ),
    );
  const caseScores = new Map<string, number[]>(),
    axisValues = Object.fromEntries(
      QUALITY_CONDITIONS.map((condition) => [
        condition,
        Object.fromEntries(
          QUALITY_AXIS_KEYS.map((axis) => [axis, [] as number[]]),
        ),
      ]),
    ) as Record<
      QualityCondition,
      Record<(typeof QUALITY_AXIS_KEYS)[number], number[]>
    >;
  const overall: Record<QualityCondition, number[]> = {
      baseline: [],
      candidate: [],
    },
    worthwhile: Record<QualityCondition, number[]> = {
      baseline: [],
      candidate: [],
    },
    criticalErrors: Record<QualityCondition, string[]> = {
      baseline: [],
      candidate: [],
    };
  const comparisons = [];
  for (const [id, judgments] of byComparison) {
    const map = report.blindConditionMap[id];
    let candidateVotes = 0,
      baselineVotes = 0,
      ties = 0;
    for (const judgment of judgments) {
      if (judgment.preferred === "tie") ties++;
      else if (map[judgment.preferred] === "candidate") candidateVotes++;
      else baselineVotes++;
      for (const label of ["A", "B"] as const) {
        const condition = map[label],
          list = judgment.ratings[label];
        for (const axis of QUALITY_AXIS_KEYS)
          axisValues[condition][axis].push(list.axes[axis]);
        overall[condition].push(list.overallUsefulness);
        worthwhile[condition].push(
          list.items.filter(
            (item) => item.verdict === "strong" || item.verdict === "useful",
          ).length,
        );
        criticalErrors[condition].push(...list.criticalErrors.filter(Boolean));
      }
    }
    const majority = Math.floor(judgments.length / 2) + 1,
      score =
        candidateVotes >= majority ? 1 : baselineVotes >= majority ? 0 : 0.5,
      caseId = judgments[0].caseId;
    caseScores.set(caseId, [...(caseScores.get(caseId) ?? []), score]);
    comparisons.push({
      comparisonId: id,
      caseId,
      candidateVotes,
      baselineVotes,
      ties,
      caseMajorityScore: score,
    });
  }
  const perCase = [...caseScores].map(([caseId, scores]) => ({
      caseId,
      score: mean(scores),
    })),
    pairwiseScore = mean(perCase.map((item) => item.score)),
    interval = wilsonInterval(
      perCase.reduce((sum, item) => sum + item.score, 0),
      perCase.length,
    );
  const listwise = Object.fromEntries(
    QUALITY_CONDITIONS.map((condition) => [
      condition,
      {
        axisMeans: Object.fromEntries(
          QUALITY_AXIS_KEYS.map((axis) => [
            axis,
            mean(axisValues[condition][axis]),
          ]),
        ),
        meanOverallUsefulness: mean(overall[condition]),
        meanWorthwhileItems: mean(worthwhile[condition]),
        criticalErrorCount: criticalErrors[condition].length,
        criticalErrors: criticalErrors[condition],
      },
    ]),
  ) as Record<
    QualityCondition,
    {
      axisMeans: Record<string, number>;
      meanOverallUsefulness: number;
      meanWorthwhileItems: number;
      criticalErrorCount: number;
      criticalErrors: string[];
    }
  >;
  const thresholds = {
    minimumHumanReviewers: 3,
    minimumHoldoutCases: 40,
    pairwiseCandidateScore: 0.6,
    pairwiseWilsonLowerBound: 0.5,
    meanOverallUsefulness: 4,
    meanWorthwhileItems: 8,
    criticalErrors: 0,
  };
  const checks = {
    humanReviewers: ratings.length >= thresholds.minimumHumanReviewers,
    holdoutCases: perCase.length >= thresholds.minimumHoldoutCases,
    pairwiseScore: pairwiseScore >= thresholds.pairwiseCandidateScore,
    pairwiseLowerBound: interval.low > thresholds.pairwiseWilsonLowerBound,
    overallUsefulness:
      listwise.candidate.meanOverallUsefulness >=
      thresholds.meanOverallUsefulness,
    worthwhileItems:
      listwise.candidate.meanWorthwhileItems >= thresholds.meanWorthwhileItems,
    criticalErrors:
      listwise.candidate.criticalErrorCount === thresholds.criticalErrors,
  };
  const complete = checks.humanReviewers && checks.holdoutCases,
    status = !complete
      ? "incomplete"
      : Object.values(checks).every(Boolean)
        ? "pass"
        : "fail";
  return {
    version: 1,
    packetId: report.packetId,
    createdAt: new Date().toISOString(),
    judgePolicy: {
      gatingJudge: "blind_human_panel",
      llmJudge: {
        gating: false,
        note: "LLM judge votes are not accepted by this scorer.",
      },
    },
    reviewers: reviewerIds,
    caseCount: perCase.length,
    comparisonCount: expected.length,
    pairwise: {
      candidateScore: pairwiseScore,
      caseLevelWilson95: interval,
      perCase,
      comparisons,
    },
    listwise,
    gate: { status, thresholds, checks },
  };
}

async function main() {
  try {
    const options = parseScoreOptions(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    const [reportText, ...ratingTexts] = await Promise.all([
      readFile(resolve(options.report), "utf8"),
      ...options.ratings.map((file) => readFile(resolve(file), "utf8")),
    ]);
    const result = scoreHumanRatings(
        JSON.parse(reportText),
        ratingTexts.map((text) => JSON.parse(text)),
      ),
      serialized = JSON.stringify(result, null, 2) + "\n";
    if (options.out) {
      const target = resolve(options.out);
      try {
        await lstat(target);
        throw new Error("Output already exists.");
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, serialized, { mode: 0o600, flag: "wx" });
    }
    console.log(serialized.trimEnd());
  } catch (error) {
    console.error(
      `STRADA human quality scorer: ${error instanceof Error ? error.message : "SCORING_FAILED"}`,
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main();
