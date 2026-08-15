import { Agent } from "@mastra/core/agent";
import { getVehicle } from "../tools/get-vehicle";
import { createVehicle } from "../tools/create-vehicle";
import { webFetch, webSearch } from "../tools/web-access";

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

    If the information is not already in the database use the webSearch and webFetch tools to make
    a web search to get the average price and common issues of the make, model and year.

    After using the webSearch and webFetch tools use the createVehicle tool to add the vehicle information
    to the database. Seperate the make, model and year and put them in the respected fields move all
    other information to the description field. Finally give the result from the webResearch tool to the user.

    Do not make up any information about the vehicle, only return information form the web searches.
  `,

  memory,

  model: "google/gemini-3.5-flash-lite",

  // The research loop is getVehicle -> webSearch (often several) -> webFetch ->
  // createVehicle -> summarise. Mastra's default step cap of 5 truncates that
  // mid-loop, so the agent returns no text and never records the vehicle.
  defaultOptions: { maxSteps: 15 },

  tools: {
    createVehicle, getVehicle, webFetch, webSearch
  },
});