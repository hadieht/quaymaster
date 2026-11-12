// Removal of images, networks and volumes with reclaimed-storage reporting (docs/ARCHITECTURE.md 7.6).

export type StorageCleanupCategory = 'unused_networks' | 'anonymous_volumes' | 'named_volumes';

export type StorageKind = 'volume' | 'network';

/** One resource a storage cleanup preview would remove. */
export interface StorageCandidate {
  /** `volume:<name>` or `network:<id>`; the execute call only accepts ids from the stored preview. */
  id: string;
  kind: StorageKind;
  category: StorageCleanupCategory;
  name: string;
  /** Volumes: bytes Docker reports for the volume (UsageData). Networks free no disk: always 0. */
  size: number | null;
  createdAt: string | null;
  ageHours: number | null;
  /** Anonymous volume = name is a 64-hex hash created by `-v /path` without a name. */
  anonymous: boolean;
  composeProject: string | null;
  /** Best available hint about who used it last (Compose project/volume label). null = unknown. */
  lastKnownUser: string | null;
  note: string;
}

export interface StorageProtected {
  name: string;
  kind: StorageKind;
  reason: string;
}

export interface StorageCleanupRequest {
  categories: StorageCleanupCategory[];
  /** Volumes that belong to a Compose project still on disk: explicit opt-in. */
  includeComposeProjectVolumes?: boolean;
  minAgeHours?: number;
}

export interface StorageCleanupPreview {
  previewId: string;
  expiresAt: string;
  categories: StorageCleanupCategory[];
  includeComposeProjectVolumes: boolean;
  minAgeHours: number;
  candidates: StorageCandidate[];
  protected: StorageProtected[];
  /** Sum of volume sizes. Networks free nothing. */
  estimatedBytes: number;
  /** The exact text the admin must type to execute (null when no volume is included). */
  confirmPhrase: string | null;
  /** True when at least one candidate is a volume: removal permanently deletes data. */
  deletesData: boolean;
}

/** What was actually measured around a removal. */
export interface ReclaimReport {
  estimatedBytes: number;
  /** Growth of free space on the Docker root filesystem (statfs); null when not measurable. */
  freeSpaceDeltaBytes: number | null;
  /** Shrinkage of what `/system/df` accounts for (image layers + volumes); null when not measurable. */
  dfDeltaBytes: number | null;
  /** Best figure to show: the df delta when known, else the free-space delta, else the estimate. */
  reclaimedBytes: number;
  basis: 'df' | 'statfs' | 'estimate';
  note: string;
  /**
   * Set when other activity on the host distorted the measurement: the headline was capped at the size of what
   * was removed, or Docker usage grew meanwhile so the figure is lower than the estimate. Show it next to the number.
   */
  caveat?: string | null;
}

export interface StorageCleanupResult {
  removed: { id: string; name: string; kind: StorageKind; bytes: number }[];
  skipped: { id: string; name: string; reason: string }[];
  reclaim: ReclaimReport;
}

export interface ResourceRemoveResult {
  kind: 'volume' | 'network' | 'image';
  name: string;
  /** Images only: `untagged` removed a single tag and kept the image, `deleted` removed the image. */
  action: 'deleted' | 'untagged';
  removedTags: string[];
  remainingTags: string[];
  reclaim: ReclaimReport;
}
