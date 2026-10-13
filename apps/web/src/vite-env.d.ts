/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `central` when built to be served by Nibblets Connect. */
  readonly VITE_NIBBLET_MODE?: string;
}
