/**
 * AI provider contract.
 *
 * Model output is *untrusted input*: implementations must return raw text and
 * the application validates it against the Zod schemas in `@recall/shared`
 * before anything is persisted. Providers must never throw away user data.
 */
import type { Classification, CaptureKind } from '@recall/shared';

export interface ClassificationRequest {
  /** The original capture text, unmodified. */
  text: string;
  capturedAt: Date;
  /**
   * Reference "now" used to resolve relative dates. For stored captures this is
   * the original `capturedAt`, so reprocessing is deterministic.
   */
  referenceNow: Date;
  timeZone: string;
  /** Local HH:MM defaults used for vague expressions. */
  morningDefaultTime: string;
  eveningDefaultTime: string;
  /** Optional nudge from an explicit command. */
  hintKind?: CaptureKind | null;
  /** Existing project names, to encourage reuse instead of creating new ones. */
  knownProjects?: string[];
}

export interface EvidenceRecord {
  type: string;
  id: string;
  title: string;
  snippet: string;
  timestamp: string;
  status?: string | null;
  /** The timestamp in the owner's zone, e.g. "Sun 18 Oct 2026, 09:00". */
  localTime?: string;
}

export interface AnswerRequest {
  question: string;
  timeZone: string;
  referenceNow: Date;
  evidence: EvidenceRecord[];
}

export interface AiAnswer {
  answer: string;
  /** Ids from `evidence` that the answer relies on. */
  citedIds: string[];
}

export interface AiProvider {
  readonly name: string;
  readonly model: string | null;
  /** Structured classification. May throw `ProviderError`. */
  classify(request: ClassificationRequest): Promise<Classification>;
  /** Grounded answer over supplied evidence only. */
  answer(request: AnswerRequest): Promise<AiAnswer>;
}

/** Deterministic classification used when no AI provider is configured. */
export interface RuleClassifier {
  classify(request: ClassificationRequest): Classification;
}
