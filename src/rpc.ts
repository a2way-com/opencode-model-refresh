import { Rpc } from "@opencode/plugin/rpc"
import { RPC_ID } from "./ids.ts"

const summary = {
  type: "object",
  properties: {
    provider: { type: "string" },
    offered: { type: "integer" },
    probed: { type: "integer" },
    ok: { type: "integer" },
    refused: { type: "integer" },
    guarded: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["provider"],
  additionalProperties: false,
} as const

const historyEntry = {
  type: "object",
  properties: {
    at: { type: "string" },
    provider: { type: "string" },
    added: { type: "array", items: { type: "string" } },
    removed: { type: "array", items: { type: "string" } },
    guarded: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["at", "provider", "added", "removed"],
  additionalProperties: false,
} as const

export const ModelSync = Rpc.define({
  id: RPC_ID,
  methods: {
    refresh: {
      input: {
        type: "object",
        properties: { force: { type: "boolean" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          providers: {
            type: "array",
            items: summary,
          },
        },
        required: ["providers"],
        additionalProperties: false,
      },
      errors: {},
    },
    history: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: historyEntry,
          },
        },
        required: ["events"],
        additionalProperties: false,
      },
      errors: {},
    },
  },
  events: {},
})
