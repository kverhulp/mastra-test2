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
});

const ResearchStep = createStep({
  id: "research",
  inputSchema: LookupOutput,
  outputSchema: ResearchOutput,
  execute: async ({ inputData }) => {
    // Cache hit: nothing to research, and no model call at all.
    if (inputData.cached) {
      return { ...inputData, research: null, sources: [], grounded: false };
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

    return {
      ...inputData,
      research: result.text,
      sources: chunks
        .map((c) => c.web?.uri)
        .filter((u): u is string => typeof u === "string"),
      // The check that matters. Ungrounded, this model answers from training
      // data in convincing prose with no citations — which for research is
      // worse than failing, because it reads as fact.
      grounded: chunks.length > 0,
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
      const cached = inputData.cached as { description?: string | null };
      return {
        ...base,
        fromCache: true,
        research: cached.description ?? null,
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
        stored: false,
        error: "not stored: the answer was not grounded in search results",
      };
    }

    // avg_price is required by the table and is not reliably extractable from
    // prose, so the description carries the research and the price stays 0
    // until something parses it out. A wrong number would be worse than none.
    const saved = await saveVehicle({
      year: inputData.year,
      make: inputData.make,
      model: inputData.model,
      avg_price: 0,
      description: inputData.research,
    });

    return {
      ...base,
      fromCache: false,
      research: inputData.research,
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
