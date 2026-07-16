import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface StateFile {
  seenKeys: string[];
  holderAlerts?: Record<string, HolderAlertState>;
  addressSeenKeys?: Record<string, number>;
  addressInitialKeys?: string[];
  addressCursors?: Record<string, number>;
  addressAggregates?: Record<string, AddressAggregateState>;
}

export interface HolderAlertState {
  wallet: string;
  marketSlug: string;
  outcomeTokenId: string;
  outcome: string;
  lastAlertedCostUsdc: number;
  shares: number;
  avgPrice: number;
  lastAlertedAt: string;
}

export interface AddressAggregateState {
  wallet: string;
  walletLabel?: string;
  marketSlug: string;
  marketTitle?: string;
  eventSlug: string;
  conditionId?: string;
  asset?: string;
  outcome?: string;
  side: "BUY" | "SELL";
  totalSize: number;
  totalCashValue: number;
  tradeCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  transactionHashes: string[];
  bucketStartedAt: number;
}

export class AlertStateStore {
  private constructor(
    private readonly stateFile: string,
    private readonly seenKeys: Set<string>,
    private readonly holderAlerts: Map<string, HolderAlertState>,
    private readonly addressSeenKeys: Map<string, number>,
    private readonly addressInitialKeys: Set<string>,
    private readonly addressCursors: Map<string, number>,
    private readonly addressAggregates: Map<string, AddressAggregateState>
  ) {}

  static async load(stateFile: string): Promise<AlertStateStore> {
    await mkdir(path.dirname(stateFile), { recursive: true });

    try {
      const raw = await readFile(stateFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      return new AlertStateStore(
        stateFile,
        new Set(parsed.seenKeys ?? []),
        new Map(Object.entries(parsed.holderAlerts ?? {})),
        new Map(Object.entries(parsed.addressSeenKeys ?? {})),
        new Set(parsed.addressInitialKeys ?? []),
        new Map(Object.entries(parsed.addressCursors ?? {})),
        new Map(Object.entries(parsed.addressAggregates ?? {}))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return new AlertStateStore(stateFile, new Set(), new Map(), new Map(), new Set(), new Map(), new Map());
    }
  }

  has(key: string): boolean {
    return this.seenKeys.has(key);
  }

  async markSeen(key: string): Promise<void> {
    this.seenKeys.add(key);
    await this.save();
  }

  getHolderAlert(key: string): HolderAlertState | undefined {
    return this.holderAlerts.get(key);
  }

  async markHolderAlert(key: string, state: HolderAlertState): Promise<void> {
    this.holderAlerts.set(key, state);
    await this.save();
  }

  async appendAlert(historyFile: string, alert: unknown): Promise<void> {
    await mkdir(path.dirname(historyFile), { recursive: true });
    await appendFile(historyFile, `${JSON.stringify({ ...asRecord(alert), alertedAt: new Date().toISOString() })}\n`);
  }

  hasAddressTrade(key: string): boolean {
    return this.addressSeenKeys.has(key);
  }

  async markAddressTrade(key: string, timestamp: number): Promise<void> {
    this.addressSeenKeys.set(key, timestamp);
    await this.save();
  }

  hasAddressInitial(key: string): boolean {
    return this.addressInitialKeys.has(key);
  }

  async markAddressInitial(key: string): Promise<void> {
    this.addressInitialKeys.add(key);
    await this.save();
  }

  getAddressCursor(wallet: string): number | undefined {
    return this.addressCursors.get(wallet.toLowerCase());
  }

  async markAddressCursor(wallet: string, timestamp: number): Promise<void> {
    const key = wallet.toLowerCase();
    const previous = this.addressCursors.get(key) ?? 0;
    this.addressCursors.set(key, Math.max(previous, timestamp));
    await this.save();
  }

  getAddressAggregate(key: string): AddressAggregateState | undefined {
    return this.addressAggregates.get(key);
  }

  async setAddressAggregate(key: string, aggregate: AddressAggregateState): Promise<void> {
    this.addressAggregates.set(key, aggregate);
    await this.save();
  }

  async deleteAddressAggregate(key: string): Promise<void> {
    this.addressAggregates.delete(key);
    await this.save();
  }

  getAddressAggregates(): Array<[string, AddressAggregateState]> {
    return [...this.addressAggregates.entries()];
  }

  async pruneAddressSeen(beforeTimestamp: number): Promise<void> {
    for (const [key, timestamp] of this.addressSeenKeys) {
      if (timestamp < beforeTimestamp) {
        this.addressSeenKeys.delete(key);
      }
    }
    await this.save();
  }

  private async save(): Promise<void> {
    const payload: StateFile = {
      seenKeys: [...this.seenKeys].sort(),
      holderAlerts: Object.fromEntries([...this.holderAlerts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      addressSeenKeys: Object.fromEntries([...this.addressSeenKeys.entries()].sort(([left], [right]) => left.localeCompare(right))),
      addressInitialKeys: [...this.addressInitialKeys].sort(),
      addressCursors: Object.fromEntries([...this.addressCursors.entries()].sort(([left], [right]) => left.localeCompare(right))),
      addressAggregates: Object.fromEntries([...this.addressAggregates.entries()].sort(([left], [right]) => left.localeCompare(right)))
    };
    await writeFile(this.stateFile, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
