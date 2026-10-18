import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DirectorBridge } from "../bridge/directorBridge.js";
import { EventCatalog } from "../events/eventCatalog.js";
import { EventLog } from "../events/eventLog.js";
import { ActivityLog } from "../events/activityLog.js";
import { ResponseHooks } from "../hooks/responseHooks.js";
import { protocolVersion } from "../protocol/bridge.js";
import { gameEventDefinitions } from "../protocol/gameEvent.js";
import { openDatabase } from "../storage/database.js";
import { openActivityDatabase } from "../storage/activityDatabase.js";
import { HistorySummaries } from "../storage/historySummaries.js";
import { openSummaryDatabase } from "../storage/summaryDatabase.js";
import { ConnectionFile, type ConnectionInfo } from "./connectionFile.js";
import { PrivateDataDirectory } from "./privateDataDirectory.js";

interface RuntimeOptions {
  dataDirectory: string;
  signal: AbortSignal;
  onFault: (error: Error) => void;
}
export interface BridgeRuntime {
  bridge: DirectorBridge;
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
  let bridge: DirectorBridge | undefined;
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
      if (errors.length) throw new AggregateError(errors, "Could not shut down Director");
    })());
  };
  try {
    directory.assertStorageFiles();
    db = openDatabase(directory.databasePath);
    activityDb = openActivityDatabase(directory.activityDatabasePath);
    summaryDb = openSummaryDatabase(directory.summaryDatabasePath);
    directory.assertStorageFiles();
    const catalog = new EventCatalog(gameEventDefinitions);
    const eventLog = new EventLog(db, catalog);
    const token = randomBytes(32).toString("base64url");
    bridge = new DirectorBridge({
      token,
      eventLog,
      activityLog: new ActivityLog(activityDb),
      history: new HistorySummaries(eventLog, summaryDb),
      hooks: new ResponseHooks(activityDb, catalog),
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
      throw new AggregateError([error, cleanupError], "Director startup and cleanup failed");
    }
    throw error;
  }
}
