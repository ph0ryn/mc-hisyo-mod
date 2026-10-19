import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BridgeServer } from "../bridge/bridgeServer.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "../storage/eventLog.js";
import { ActivityLog } from "../storage/activityLog.js";
import { HookStore } from "../storage/hookStore.js";
import { protocolVersion } from "../protocol/bridge.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { openEventDatabase } from "../storage/eventDatabase.js";
import { openActivityDatabase } from "../storage/activityDatabase.js";
import { SummaryStore } from "../storage/summaryStore.js";
import { openSummaryDatabase } from "../storage/summaryDatabase.js";
import { ConnectionFile, type ConnectionInfo } from "./connectionFile.js";
import { PrivateDataDirectory } from "./privateDataDirectory.js";

interface RuntimeOptions {
  dataDirectory: string;
  signal: AbortSignal;
  onFault: (error: Error) => void;
}
export interface BridgeRuntime {
  bridge: BridgeServer;
  connection: ConnectionInfo;
  close: () => Promise<void>;
}

export async function startBridgeRuntime(options: RuntimeOptions): Promise<BridgeRuntime> {
  options.signal.throwIfAborted();
  const directory = new PrivateDataDirectory(options.dataDirectory);
  const discovery = new ConnectionFile(directory);
  let db: DatabaseSync | undefined;
  let activityDb: DatabaseSync | undefined;
  let summaryDb: DatabaseSync | undefined;
  let bridge: BridgeServer | undefined;
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    return (shutdown ??= (async () => {
      const errors: unknown[] = [];
      try {
        await bridge?.close();
      } catch (error) {
        errors.push(error);
      }
      for (const database of [summaryDb, activityDb, db]) {
        try {
          database?.close();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        discovery.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Could not shut down hisyo");
    })());
  };
  try {
    directory.assertStorageFiles();
    db = openEventDatabase(directory.eventDatabasePath);
    activityDb = openActivityDatabase(directory.activityDatabasePath);
    summaryDb = openSummaryDatabase(directory.summaryDatabasePath);
    directory.assertStorageFiles();
    const catalog = new EventCatalog(gameEventDefinitions);
    const eventLog = new EventLog(db, catalog);
    const token = randomBytes(32).toString("base64url");
    bridge = new BridgeServer({
      token,
      eventLog,
      activityLog: new ActivityLog(activityDb),
      summaries: new SummaryStore(eventLog, summaryDb),
      hooks: new HookStore(activityDb, catalog),
    });
    bridge.on("fault", options.onFault);
    const address = await bridge.listen();
    options.signal.throwIfAborted();
    const connection: ConnectionInfo = { protocolVersion, ...address, token, pid: process.pid };
    discovery.publish(connection);
    options.signal.throwIfAborted();
    return { bridge, connection, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Hisyo startup and cleanup failed");
    }
    throw error;
  }
}
