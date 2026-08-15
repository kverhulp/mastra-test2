import { supabase } from "./supabase";

/**
 * The vehicles cache, as plain functions.
 *
 * Extracted from get-vehicle / create-vehicle so the same queries back both the
 * tools and the research workflow. Two implementations of "is this vehicle
 * already known" would eventually disagree about normalisation, and the answer
 * decides whether we pay for a web search.
 */

/** "F-150" -> "F 150", "  Toyota  " -> "Toyota". */
export function normalizeVehicleName(value: string): string {
  return value.trim().replace(/-/g, " ").replace(/\s+/g, " ");
}

export interface CachedVehicle {
  year: number;
  make: string;
  model: string;
  avg_price: number | null;
  description: string | null;
  [key: string]: unknown;
}

export async function findVehicle(
  year: number,
  make: string,
  model: string,
): Promise<CachedVehicle | null> {
  const { data, error } = await supabase
    .from("vehicles")
    .select("*")
    .eq("year", year)
    .ilike("make", normalizeVehicleName(make))
    .ilike("model", normalizeVehicleName(model))
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch vehicle: ${error.message}`);
  return (data as CachedVehicle | null) ?? null;
}

export interface SaveVehicleInput {
  year: number;
  make: string;
  model: string;
  avg_price: number;
  description: string;
}

export interface SaveVehicleResult {
  created: boolean;
  vehicle: CachedVehicle | null;
  error: string | null;
}

/** Idempotent: an existing row is returned rather than duplicated. */
export async function saveVehicle(input: SaveVehicleInput): Promise<SaveVehicleResult> {
  const make = normalizeVehicleName(input.make);
  const model = normalizeVehicleName(input.model);

  try {
    const existing = await findVehicle(input.year, make, model);
    if (existing) return { created: false, vehicle: existing, error: null };
  } catch (cause) {
    return { created: false, vehicle: null, error: (cause as Error).message };
  }

  const { data, error } = await supabase
    .from("vehicles")
    .insert({ year: input.year, make, model, avg_price: input.avg_price, description: input.description })
    .select()
    .single();

  if (error) {
    return { created: false, vehicle: null, error: `Failed to create vehicle: ${error.message}` };
  }
  return { created: true, vehicle: data as CachedVehicle, error: null };
}
