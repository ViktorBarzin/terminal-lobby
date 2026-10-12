/**
 * The Claude models the composer offers, as T3 provider models.
 *
 * The rows mirror the lobby's own catalogue, frontend-v2/src/lib/models.ts
 * (CATALOGUE.claude and CLAUDE_EFFORTS): every slug there is one this account
 * can run and one the CLI's picker draws, which is what POST /model/{session}
 * matches on. Keep the two in step until the lobby serves that list itself.
 */
import type { ServerProviderModel } from "@t3tools/contracts";

const FIVE_RUNGS = ["low", "medium", "high", "xhigh", "max"] as const;

const EFFORT_LABELS: Readonly<Record<(typeof FIVE_RUNGS)[number], string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

interface LobbyClaudeModel {
  readonly slug: string;
  readonly name: string;
  readonly efforts: ReadonlyArray<(typeof FIVE_RUNGS)[number]>;
}

/** In the order the lobby's picker lists them; the first is the box's start model. */
export const LOBBY_CLAUDE_MODELS: ReadonlyArray<LobbyClaudeModel> = [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: FIVE_RUNGS },
  { slug: "claude-opus-5", name: "Claude Opus 5", efforts: FIVE_RUNGS },
  { slug: "claude-opus-5[1m]", name: "Claude Opus 5 (1M)", efforts: FIVE_RUNGS },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5", efforts: FIVE_RUNGS },
  { slug: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", efforts: [] },
  { slug: "claude-opus-4-8", name: "Claude Opus 4.8", efforts: FIVE_RUNGS },
];

/** The catalogue's slugs: the models the composer offers whatever sessions run. */
export const LOBBY_CLAUDE_SLUGS: ReadonlySet<string> = new Set(
  LOBBY_CLAUDE_MODELS.map((m) => m.slug),
);

/**
 * The provider's model rows: the catalogue, then each model a live session is
 * on that the catalogue lacks (a pre-warm alias such as claude-haiku-5-5),
 * named by its slug. Without its row the composer would show its default
 * model for such a session, and a send would carry that default.
 */
export function providerModels(liveModels: ReadonlyArray<string>): ServerProviderModel[] {
  const extra = [...new Set(liveModels)]
    .filter((slug) => slug !== "" && !LOBBY_CLAUDE_SLUGS.has(slug))
    .sort();
  return [
    ...LOBBY_CLAUDE_MODELS.map((model, index) => toProviderModel(model, index === 0)),
    ...extra.map((slug) => toProviderModel({ slug, name: slug, efforts: [] }, false)),
  ];
}

export function toProviderModel(model: LobbyClaudeModel, isDefault: boolean): ServerProviderModel {
  return {
    slug: model.slug,
    name: model.name,
    isCustom: false,
    ...(isDefault ? { isDefault: true } : {}),
    capabilities:
      model.efforts.length === 0
        ? { optionDescriptors: [] }
        : {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: model.efforts.map((effort) => ({
                  id: effort,
                  label: EFFORT_LABELS[effort],
                  ...(effort === "medium" ? { isDefault: true } : {}),
                })),
              },
            ],
          },
  };
}
