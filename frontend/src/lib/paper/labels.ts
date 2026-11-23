import type { ObjectKind } from "./types";

export const KIND_LABELS: Record<ObjectKind, string> = {
  equation: "수식",
  figure: "그림",
  table: "표",
  section: "절",
};

export const LABEL_PREFIX: Record<ObjectKind, string> = {
  equation: "eq",
  figure: "fig",
  table: "tab",
  section: "sec",
};
