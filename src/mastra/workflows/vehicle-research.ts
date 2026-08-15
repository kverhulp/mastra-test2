import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { findVehicle, saveVehicle } from "../lib/vehicles";
import { researchAgent } from "../agents/research-agent";

/**
 * Cache-first vehicle research.
 *
 *   lookup -> (hit) done
 *          -> (miss) research with search grounding -> persist
 *
 * The cache read and write are steps rather than tools on purpose, and not only
 * for tidiness: **Gemini rejects `google_search` grounding in the same request
 * as function-calling tools.** With getVehicle/createVehicle declared alongside
 * it, the research turn comes back `contents[3].parts[0]: Corrupted tool call
 * context` — a 500 on every cache miss, which is every vehicle we have not seen
 * before. Grounding-only, the same request returns five grounding chunks and
 * eight source URLs.
 *
 * It is also the cheaper shape. A cache hit now costs zero tokens instead of a
 * model round-trip spent deciding to read the cache — and looking a row up was
 * never a judgement call worth paying a model for.
 */

const VehicleQuery = z.object({
  year: z.number().int().min(1900).max(2100),
  make: z.string().min(1),
  model: z.string().min(1),
});

const LookupOutput = VehicleQuery.extend({
  cached: z.any().nullable(),
});

const LookupStep = createStep({
  id: "lookup",
  inputSchema: VehicleQuery,
  outputSchema: LookupOutput,
  execute: async ({ inputData }) => ({
    ...inputData,
    cached: await findVehicle(inputData.year, inputData.make, inputData.model),
  }),
});

const ResearchOutput = LookupOutput.extend({
  research: z.string().nullable(),
  /** Where the claims came from. Empty when the answer was already cached. */
  sources: z.array(z.string()),
  grounded: z.boolean(),
  /** Null when the research never stated one. Never estimated. */
  avgPriceCad: z.number().nullable(),
});

/**
 * Pulls the headline number back out of the prose.
 *
 * The old agent got this for free: it called createVehicle directly and the
 * model filled in avg_price. Grounding took that away — the model cannot search
 * and call a typed tool in the same request — so the number is recovered in a
 * second pass over the text it already produced.
 *
 * Reading rather than researching is the point. This pass has no search and is
 * told to return null rather than estimate, so it can only report a figure the
 * grounded text actually stated.
 */
const PriceExtraction = z.object({
  averageCad: z
    .number()
    .positive()
    .nullable()
    .describe("A single average price in CAD if the text states one, else null"),
  lowCad: z
    .number()
    .positive()
    .nullable()
    .describe("Bottom of the price range in CAD if the text gives a range, else null"),
  highCad: z
    .number()
    .positive()
    .nullable()
    .describe("Top of the price range in CAD if the text gives a range, else null"),
});

/**
 * Research usually states a range — "typically $4,000 to $7,000 CAD" — rather
 * than a single figure. Asking only for an average made the extractor correctly
 * answer null on the common case, so almost nothing reached the cache.
 *
 * The midpoint is computed here rather than asked for: deriving it is
 * arithmetic, and arithmetic is not something to pay a model to do or to trust
 * it with.
 */
function priceFrom(extracted: z.infer<typeof PriceExtraction>): number | null {
  if (extracted.averageCad !== null) return Math.round(extracted.averageCad);
  const { lowCad, highCad } = extracted;
  if (lowCad !== null && highCad !== null) return Math.round((lowCad + highCad) / 2);
  return lowCad ?? highCad ?? null;
}

const ResearchStep = createStep({
  id: "research",
  inputSchema: LookupOutput,
  outputSchema: ResearchOutput,
  execute: async ({ inputData }) => {
    // Cache hit: nothing to research, and no model call at all.
    if (inputData.cached) {
      return { ...inputData, research: null, sources: [], grounded: false, avgPriceCad: null };
    }

    const { year, make, model } = inputData;
    const result = await researchAgent.generate(
      `Research a ${year} ${make} ${model}. Give the average used asking price ` +
        `in Canada and the problems owners commonly report. Say so plainly if ` +
        `the search results do not cover something.`,
    );

    /*
     * Citations come off groundingChunks, not `result.sources` — that array is
     * empty even on a grounded answer, which would have shipped confident
     * research with nothing to check it against.
     */
    const metadata = result.providerMetadata as
      | {
          google?: {
            groundingMetadata?: {
              groundingChunks?: Array<{ web?: { uri?: string } }>;
            };
          };
        }
      | undefined;
    const chunks = metadata?.google?.groundingMetadata?.groundingChunks ?? [];

    const grounded = chunks.length > 0;

    // Only worth reading a price out of text that was actually grounded.
    let avgPriceCad: number | null = null;
    if (grounded && result.text) {
      try {
        const extracted = await researchAgent.generate(
          `Read the vehicle research below and report the used asking price in ` +
            `Canadian dollars. If it states a single average, put it in ` +
            `averageCad. If it states a range, put the ends in lowCad and ` +
            `highCad. Use null for anything the text does not state. Do not ` +
            `estimate and do not search.\n\n${result.text}`,
          { structuredOutput: { schema: PriceExtraction } },
        );
        avgPriceCad = extracted.object ? priceFrom(extracted.object) : null;
      } catch {
        // A missing price is survivable; a wrong one is not. The research text
        // still carries the figure for a human to read.
        avgPriceCad = null;
      }
    }

    return {
      ...inputData,
      research: result.text,
      avgPriceCad,
      sources: chunks
        .map((c) => c.web?.uri)
        .filter((u): u is string => typeof u === "string"),
      // The check that matters. Ungrounded, this model answers from training
      // data in convincing prose with no citations — which for research is
      // worse than failing, because it reads as fact.
      grounded,
    };
  },
});

const PersistStep = createStep({
  id: "persist",
  inputSchema: ResearchOutput,
  outputSchema: z.object({
    year: z.number(),
    make: z.string(),
    model: z.string(),
    fromCache: z.boolean(),
    grounded: z.boolean(),
    research: z.string().nullable(),
    avgPriceCad: z.number().nullable(),
    sources: z.array(z.string()),
    stored: z.boolean(),
    error: z.string().nullable(),
  }),
  execute: async ({ inputData }) => {
    const base = {
      year: inputData.year,
      make: inputData.make,
      model: inputData.model,
      grounded: inputData.grounded,
      sources: inputData.sources,
    };

    if (inputData.cached) {
      const cached = inputData.cached as {
        description?: string | null;
        avg_price?: number | null;
      };
      return {
        ...base,
        fromCache: true,
        research: cached.description ?? null,
        // A stored 0 means "never extracted", not "free".
        avgPriceCad: cached.avg_price ? cached.avg_price : null,
        stored: false,
        error: null,
      };
    }

    /*
     * Only ungrounded research is refused a place in the cache. Storing it
     * would launder a guess into a fact that every later lookup returns
     * without ever searching again.
     */
    if (!inputData.grounded || inputData.research === null) {
      return {
        ...base,
        fromCache: false,
        research: inputData.research,
        avgPriceCad: inputData.avgPriceCad,
        stored: false,
        error: "not stored: the answer was not grounded in search results",
      };
    }

    /*
     * `vehicles.avg_price` is NOT NULL, so research that found no price has
     * nowhere to go. Skipped deliberately rather than attempted and rejected —
     * and never written as 0, which would read as free rather than as unknown
     * and would then be served from cache forever.
     *
     * The cost is re-searching those vehicles. Making the column nullable would
     * let "we looked, and there is no Canadian pricing for a 1991 Yugo Cabrio"
     * be a cacheable answer, which it should be.
     */
    if (inputData.avgPriceCad === null) {
      return {
        ...base,
        fromCache: false,
        research: inputData.research,
        avgPriceCad: null,
        stored: false,
        error: "not cached: the research stated no price, and avg_price is NOT NULL",
      };
    }

    const saved = await saveVehicle({
      year: inputData.year,
      make: inputData.make,
      model: inputData.model,
      avg_price: inputData.avgPriceCad,
      description: inputData.research,
    });

    return {
      ...base,
      fromCache: false,
      research: inputData.research,
      avgPriceCad: inputData.avgPriceCad,
      stored: saved.created,
      error: saved.error,
    };
  },
});

export const vehicleResearchWorkflow = createWorkflow({
  id: "vehicle-research",
  inputSchema: VehicleQuery,
  outputSchema: PersistStep.outputSchema,
})
  .then(LookupStep)
  .then(ResearchStep)
  .then(PersistStep)
  .commit();
