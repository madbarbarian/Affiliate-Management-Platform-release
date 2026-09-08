/**
 * The org chart.
 *
 * Six roles, one job each. A licensee adding a seventh - a translator, a legal
 * reviewer, a thumbnail designer - registers it here and wires it into the
 * pipeline in `src/kernel/orchestrator.ts`.
 */

import { analyst } from "./analyst.ts";
import { inspector } from "./inspector.ts";
import { planner } from "./planner.ts";
import { publisher } from "./publisher.ts";
import { researcher } from "./researcher.ts";
import { scout } from "./scout.ts";
import { writer } from "./writer.ts";

export { analyst, inspector, planner, publisher, researcher, scout, writer };

export type RoleSummary = { id: string; title: string; description: string };

export const roster: readonly RoleSummary[] = [
  { id: analyst.id, title: analyst.title, description: analyst.description },
  { id: researcher.id, title: researcher.title, description: researcher.description },
  { id: planner.id, title: planner.title, description: planner.description },
  { id: writer.id, title: writer.title, description: writer.description },
  { id: inspector.id, title: inspector.title, description: inspector.description },
  { id: publisher.id, title: publisher.title, description: publisher.description },
  // Not part of the daily cycle. Runs weekly, for the company rather than for
  // one venture, and its output is a proposal a person accepts or dismisses.
  { id: scout.id, title: scout.title, description: scout.description },
];

export type { AnalyzeInput } from "./analyst.ts";
export type { InspectInput } from "./inspector.ts";
export type { PlanInput, PlanOutput } from "./planner.ts";
export type { ScheduleInput, ScheduleOutput } from "./publisher.ts";
export type { ResearchInput } from "./researcher.ts";
export type { ScoutInput, ScoutOutput } from "./scout.ts";
export type { WriteInput } from "./writer.ts";
