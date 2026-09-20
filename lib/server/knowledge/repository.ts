import type { Film, Language } from "../../domain";
import type { ContextBundle } from "../curator/contract";

export interface KnowledgeRepository {
  buildContext(selected: Film[], language: Language): Promise<ContextBundle>;
  fingerprint(): string;
}
