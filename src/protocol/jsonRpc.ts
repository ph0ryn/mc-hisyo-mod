import { Type, type Static } from "typebox";

export const RpcIdSchema = Type.Union([Type.String(), Type.Number(), Type.Null()]);
export const RpcMethodSchema = Type.String({ minLength: 1, maxLength: 128 });
const ParamsSchema = Type.Union([
  Type.Record(Type.String(), Type.Unknown()),
  Type.Array(Type.Unknown()),
]);
const version = Type.Literal("2.0");
const strict = { additionalProperties: false } as const;

export const RpcRequestSchema = Type.Object(
  {
    jsonrpc: version,
    id: RpcIdSchema,
    method: RpcMethodSchema,
    params: Type.Optional(ParamsSchema),
  },
  strict,
);
export const RpcNotificationSchema = Type.Object(
  {
    jsonrpc: version,
    method: RpcMethodSchema,
    params: Type.Optional(ParamsSchema),
  },
  strict,
);
export const RpcResponseSchema = Type.Union([
  Type.Object({ jsonrpc: version, id: RpcIdSchema, result: Type.Unknown() }, strict),
  Type.Object(
    {
      jsonrpc: version,
      id: RpcIdSchema,
      error: Type.Object(
        {
          code: Type.Integer(),
          message: Type.String(),
          data: Type.Optional(Type.Unknown()),
        },
        strict,
      ),
    },
    strict,
  ),
]);

export type RpcId = Static<typeof RpcIdSchema>;
export type RpcParams = Static<typeof ParamsSchema>;
export type RpcRequest = Static<typeof RpcRequestSchema>;
export type RpcNotification = Static<typeof RpcNotificationSchema>;
