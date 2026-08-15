import { Agent } from "@mastra/core/agent";
import { insertListing } from "../tools/insert-listing";
import { researchAgent } from './research-agent';

import { Memory } from "@mastra/memory";

export const memory = new Memory({
  options: {
    lastMessages: 20,
  },
});

export const insertAgent = new Agent({
  id: "insert-agent",

  name: "Insert Agent",

  instructions: `
    Take information of the listing that the user wants to add and make sure
    it matches the fields taken by the insertListing tool and use the tool to
    add the listing to the database. Make sure to use the ID from the user when inserting.
    The insertion may fail if the listing is already in the database.

    After attmpting ot insert the listing, even if it failed,
    use the researchAgent to get additional information about the 
    specific year, make and model and return the information to the user.

    Only return information given back by the researchAgent, do not make up any information about
    the vehicle.
  `,

  memory,

  model: "google/gemini-3.5-flash-lite",

  // Insert, then delegate to researchAgent and relay its findings — more than
  // the default 5-step cap allows.
  defaultOptions: { maxSteps: 15 },

  tools: {
    insertListing
  },

  agents: {
    researchAgent
  }
});