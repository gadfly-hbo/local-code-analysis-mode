/**
 * The model-caller seam: every outbound model call in the product goes
 * through a ModelCaller. Real traffic is powered by pi-ai behind this
 * interface (AGENT-RUNTIME §4.1 adapter isolation); tests use FixtureCaller,
 * which records exactly what would have left the machine.
 */

export interface ModelCallRequest {
  system: string;
  user: string;
}

export interface ModelCallResult {
  text: string;
  stopReason: string;
}

export interface ModelCaller {
  readonly name: string;
  call(request: ModelCallRequest): Promise<ModelCallResult>;
}
