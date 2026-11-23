import type Redis from "ioredis";
import { MiniCache } from "@riavzon/utils";
import { getStorage } from "../../config/config";


export function redisStreams(): Redis | null {
  const store = getStorage();
  return store instanceof MiniCache ? null : store;
}
