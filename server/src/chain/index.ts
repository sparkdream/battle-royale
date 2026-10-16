/**
 * The process-wide chain integration. Disabled by default (CHAIN_ENABLED=1
 * plus a funded CHAIN_MNEMONIC, or a session key via CHAIN_SESSION_KEY_FILE
 * + CHAIN_GRANTER, turns it on); when off, the game behaves exactly as it
 * did before web3 existed.
 */

import type { ChainStatus, MatchEntry, MatchRecord, Web3Notice } from "@br/shared";
import { connectChain, type ChainClient } from "./client";
import { loadChainConfig, type ChainModuleConfig } from "./config";
import { Web3Recorder, type LeaderboardRow, type NoticeSink } from "./recorder";

// A failed boot (node unreachable, classes not created yet) is retried with
// backoff, so one outage at startup doesn't turn recording off until a restart.
const BOOT_RETRY_MIN_MS = 30_000;
const BOOT_RETRY_MAX_MS = 10 * 60_000;

class ChainModule {
  readonly config: ChainModuleConfig = loadChainConfig();
  private recorder: Web3Recorder | null = null;
  private relayer = "";
  private booting: Promise<void> | null = null;
  private failure = "";
  private retryMs = BOOT_RETRY_MIN_MS;
  /** Rooms register here (possibly before boot); the recorder forwards to them once it exists. */
  private sinks = new Set<NoticeSink>();

  get enabled() {
    return this.recorder !== null;
  }

  /** Connect, resolve/create the artifact classes. Safe to call more than once. */
  async init(): Promise<void> {
    if (!this.config.enabled) return;
    this.booting ??= this.boot();
    await this.booting;
  }

  private async boot() {
    try {
      const client: ChainClient = await connectChain(this.config);
      const classes = await Web3Recorder.bootstrap(client, this.config.chain.denom);
      this.relayer = client.address;
      this.recorder = new Web3Recorder(client, classes, this.config.publicUrl);
      this.recorder.onNotice((address, notice) => {
        for (const sink of this.sinks) if (sink(address, notice)) return true;
        return false;
      });
      console.log(
        `chain: onchain recording on ${this.config.chain.chainId} as ${client.address}` +
          (this.config.session ? ` through a session key (${this.config.session.keyFile})` : "") +
          ` (classes career=${classes.career} badge=${classes.badge} map=${classes.map} match=${classes.match})`,
      );
      if (!this.config.publicUrl) console.warn("chain: PUBLIC_URL is unset; match token uris will be bare paths");
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      console.error(`chain: onchain recording unavailable (${this.failure}); retrying in ${this.retryMs / 1000} s`);
      setTimeout(() => {
        this.booting = null;
        void this.init();
      }, this.retryMs).unref();
      this.retryMs = Math.min(this.retryMs * 2, BOOT_RETRY_MAX_MS);
    }
  }

  status(): ChainStatus {
    const { enabled, chain } = this.config;
    if (!enabled) return { enabled: false, chain };
    return { enabled: this.recorder !== null, chain, relayer: this.relayer || undefined };
  }

  onNotice(sink: NoticeSink) {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  async recordMatch(match: MatchRecord, entries: MatchEntry[]) {
    await this.recorder?.recordMatch(match, entries);
  }

  async chainLeaderboard(limit: number): Promise<LeaderboardRow[]> {
    return this.recorder ? this.recorder.chainLeaderboard(limit) : [];
  }

  async playerTokens(address: string) {
    return this.recorder?.playerTokens(address) ?? [];
  }
}

export const web3 = new ChainModule();
export type { LeaderboardRow };
