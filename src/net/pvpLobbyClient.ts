import type { PvpLobbyClient } from './pvpTypes';
import { PvpLobbyMock } from './pvpLobbyMock';

// Owned by the network side: replace the body with the real WebSocket client and keep `?pvpMock=1` → PvpLobbyMock.
let instance: PvpLobbyClient | null = null;

export function getPvpLobbyClient(): PvpLobbyClient {
  if (!instance) instance = new PvpLobbyMock();
  return instance;
}
