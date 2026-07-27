import { create } from 'zustand';

/**
 * Drives the global "Connect X to start this session" gate. A session-create that
 * fails with CONNECTOR_CONNECTION_REQUIRED (the acting user hasn't connected a
 * required connector) opens this; once they connect their own account, `retry`
 * re-runs the exact create that was gated.
 */
interface ConnectorGateState {
  isOpen: boolean;
  workspaceId: string | null;
  /** The connector alias the user must connect (from the error's `connector`). */
  connector: string | null;
  /** Re-run the gated session-create after the connector is connected. */
  retry: (() => void) | null;
  openConnectorGate: (opts: { workspaceId: string; connector: string; retry: () => void }) => void;
  closeConnectorGate: () => void;
}

export const useConnectorGateStore = create<ConnectorGateState>((set) => ({
  isOpen: false,
  workspaceId: null,
  connector: null,
  retry: null,
  openConnectorGate: ({ workspaceId, connector, retry }) =>
    set({ isOpen: true, workspaceId, connector, retry }),
  closeConnectorGate: () => set({ isOpen: false, workspaceId: null, connector: null, retry: null }),
}));
