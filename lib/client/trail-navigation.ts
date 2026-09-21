import { restoreSnapshot, type Session } from "../domain";

export type TrailNavigation = {
  strada: true;
  view: "entry" | "results";
  filmId?: string;
  snapshotId?: string;
};

/** Browser Forward may still refer to the C that a successful B → C′ replaced. */
export function resolveTrailNavigation(session: Session, nav: TrailNavigation | null) {
  const cursor = nav?.snapshotId
    ? session.snapshots.findIndex(snapshot => snapshot.id === nav.snapshotId) : -1;
  const restored = cursor >= 0 ? restoreSnapshot(session, cursor) : session;
  const snapshot = restored.snapshots[restored.cursor];
  const view = nav?.strada && nav.view === "results" && snapshot ? "results" : "entry";
  const normalized: TrailNavigation = {
    strada: true,
    view,
    snapshotId: view === "results" ? snapshot.id : undefined,
    filmId: view === "results" && snapshot.recommendations.some(rec => rec.film.id === nav?.filmId)
      ? nav?.filmId : undefined,
  };
  return { session: restored, nav: normalized };
}
