import type { CustomScheme } from "electron";

export const LOCAL_FILE_SCHEME = "multica-local-file";

export const localFileScheme: CustomScheme = {
  scheme: LOCAL_FILE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    // Electron requires this for fetches from the renderer's file:// origin.
    corsEnabled: true,
    stream: true,
  },
};
