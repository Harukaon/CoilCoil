/** A runtime-owned publisher remains usable after Pi retires an extension. */
export const MEMORY_STATUS_PUBLISHER_REQUEST = "coilcoil:project-memory:publisher:v1";

export interface MemoryStatusPublisherRequest {
  publish?: (value: unknown) => void;
}
