// The live room's heartbeat file, which `swarmail who` reads when SWARMAIL_LIVE_ROOM names one.
export function liveRoomPath(): string | null {
  return process.env.SWARMAIL_LIVE_ROOM || null;
}
