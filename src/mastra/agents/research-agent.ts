import { Agent } from "@mastra/core/agent";

import { Memory } from "@mastra/memory";

export const memory = new Memory({
  options: {
    lastMessages: 20,
  },
});

export const researchAgent = new Agent({
  id: "research-agent",

  name: "Reasearch Agent",

  instructions: `
    You'll give research on different vehicles from make (manufaturer), model, and year as requested by the users.

    Your first step is use the getVehicle tool to check if the database already has
    data for the vehicle by using the make (brand / manufacturer), model and year.

    If the information is already in the database return the information to the user and do not
    use any other tools.

    If the information is not in the database, search the web for the average asking
    price and the common problems for that make, model and year. Web results are
    provided to you automatically — there is no search tool to call, so read the
    results you are given rather than trying to fetch pages yourself.

    Then use the createVehicle tool to add the vehicle information to the database.
    Seperate the make, model and year and put them in the respected fields move all
    other information to the description field. Finally give the research to the user.

    Do not make up any information about the vehicle, only return what the web
    results actually say. If they do not cover something, say so.
  `,

  memory,

  model: "google/gemini-3.5-flash-lite",

  // getVehicle -> search -> createVehicle -> summarise. Still clear of the
  // default cap of 5, and the loop terminates instead of spinning.
  defaultOptions: { maxSteps: 10 },

  tools: {

    /*
     * Google's own search grounding, executed by the provider rather than by us.
     *
     * This replaced @mastra/brightdata, which was constructed with no zone names
     * and fell back to the package defaults `sdk_serp` / `sdk_unlocker`. The
     * account has no zones at all, so every search returned `bad request: zone
     * "sdk_serp" not found` — and because that arrives as a tool *result* rather
     * than an error, the agent retried it thirteen times, exhausted the step
     * cap, and returned empty text under HTTP 200.
     *
     * A provider-defined tool, not one of ours: Mastra recognises the shape
     * `{ type: "provider", id: "<provider>.<tool>" }` and translates
     * `google.google_search` into Gemini's `googleSearch` for Gemini 2 and
     * newer. It needs no second API key and no zone to provision.
     *
     * `providerOptions: { openrouter: { plugins: [{ id: "web" }] } }` was tried
     * first and silently did nothing — the Gateway routes this model to Google
     * directly, so the openrouter namespace never applied and the model simply
     * answered from training data with `sources: []`. Grounding is verifiable:
     * `providerMetadata.google.groundingMetadata` is populated when it worked.
     */
    google_search: { type: "provider", id: "google.google_search", args: {} },
  },
});
