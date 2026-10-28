import type { PluginServerContext } from "@getpaseo/plugin/server";
import { logHook } from "./server/log";

export default function contribute(server: PluginServerContext) {
  server.addHook("workspace.create.prepare", async ({ request }) => {
    logHook("workspace.create.prepare", { request });
    return request;
  });

  server.addHook("workspace.create.completed", async (event) => {
    logHook("workspace.create.completed", event);
  });

  server.addHook("workspace.archive.completed", async (event) => {
    logHook("workspace.archive.completed", event);
  });

  server.addHook("agent.create.prepare", async ({ request }) => {
    logHook("agent.create.prepare", { request });
    return request;
  });

  server.addHook("agent.open.prepare", async ({ request }) => {
    logHook("agent.open.prepare", { request });
    return request;
  });

  server.addHook("agent.create.completed", async (event) => {
    logHook("agent.create.completed", event);
  });

  server.addHook("agent.close.completed", async (event) => {
    logHook("agent.close.completed", event);
  });

  server.addHook("agent.turn.started", async (event) => {
    logHook("agent.turn.started", event);
  });

  server.addHook("agent.turn.completed", async (event) => {
    logHook("agent.turn.completed", event);
  });

  server.addHook("agent.permission.started", async (event) => {
    logHook("agent.permission.started", event);
  });

  server.addHook("agent.permission.completed", async (event) => {
    logHook("agent.permission.completed", event);
  });

  server.addHook("agent.archive.completed", async (event) => {
    logHook("agent.archive.completed", event);
  });

  return () => {};
}
