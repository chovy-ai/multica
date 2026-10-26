export type I18nPrimitive = string | number | boolean | null | undefined;

export type I18nParams = Record<string, I18nPrimitive>;

export type I18nDictionary = {
  readonly [key: string]: string | I18nDictionary;
};

export interface LocaleObjectI18nModuleManifest {
  exportMode: "locale-object";
  fileByLocale: Record<string, string>;
  name: string;
  sourceRoot?: string;
}

export interface ScopedLocaleObjectsI18nModuleManifest {
  exportMode: "scoped-locale-objects";
  localeObjectByLocale: Record<string, string>;
  name: string;
  namespace: string;
  sourceRoot: string;
}

export type I18nModuleManifest =
  | LocaleObjectI18nModuleManifest
  | ScopedLocaleObjectsI18nModuleManifest;

export function createLocaleObjectI18nModuleManifest(input: {
  fileByLocale: Record<string, string>;
  name: string;
  sourceRoot?: string;
}): LocaleObjectI18nModuleManifest {
  return {
    exportMode: "locale-object",
    fileByLocale: input.fileByLocale,
    name: input.name,
    sourceRoot: input.sourceRoot
  };
}

export function createScopedLocaleObjectsI18nModuleManifest(input: {
  localeObjectByLocale: Record<string, string>;
  name: string;
  namespace: string;
  sourceRoot: string;
}): ScopedLocaleObjectsI18nModuleManifest {
  return {
    exportMode: "scoped-locale-objects",
    localeObjectByLocale: input.localeObjectByLocale,
    name: input.name,
    namespace: input.namespace,
    sourceRoot: input.sourceRoot
  };
}

export interface I18nRuntime<TKey extends string = string> {
  has(key: TKey): boolean;
  t(key: TKey, params?: I18nParams): string;
  tFirst(keys: readonly TKey[], params?: I18nParams): string;
}

export function createI18nRuntime<TKey extends string = string>(input: {
  dictionaries: readonly I18nDictionary[];
}): I18nRuntime<TKey> {
  return {
    has(key) {
      return resolveI18nValue(input.dictionaries, key) !== null;
    },
    t(key, params) {
      const resolved = resolveI18nValue(input.dictionaries, key);
      if (resolved === null) {
        return key;
      }

      return interpolateI18nTemplate(resolved, params);
    },
    tFirst(keys, params) {
      for (const key of keys) {
        const resolved = resolveI18nValue(input.dictionaries, key);
        if (resolved !== null) {
          return interpolateI18nTemplate(resolved, params);
        }
      }

      return keys[0] ?? "";
    }
  };
}

export function createScopedI18nRuntime<TKey extends string = string>(
  runtime: I18nRuntime<string>,
  namespace: string
): I18nRuntime<TKey> {
  return {
    has(key) {
      return runtime.has(joinI18nKey(namespace, key));
    },
    t(key, params) {
      return runtime.t(joinI18nKey(namespace, key), params);
    },
    tFirst(keys, params) {
      return runtime.tFirst(
        keys.map((key) => joinI18nKey(namespace, key)),
        params
      );
    }
  };
}

function joinI18nKey(namespace: string, key: string): string {
  return `${namespace}.${key}`;
}

function resolveI18nValue(
  dictionaries: readonly I18nDictionary[],
  key: string
): string | null {
  for (const dictionary of dictionaries) {
    const resolved = resolveDictionaryValue(dictionary, key);
    if (resolved !== null) {
      return resolved;
    }
  }

  return null;
}

function resolveDictionaryValue(
  dictionary: I18nDictionary,
  key: string
): string | null {
  const segments = key.split(".");
  let current: string | I18nDictionary | undefined = dictionary;

  for (const segment of segments) {
    if (typeof current === "string" || !current) {
      return null;
    }
    current = current[segment];
  }

  return typeof current === "string" ? current : null;
}

function interpolateI18nTemplate(
  template: string,
  params: I18nParams | undefined
): string {
  if (!params) {
    return template;
  }

  return template.replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (_match: string, key: string) => {
      const value = params[key];
      return value === null || value === undefined ? "" : String(value);
    }
  );
}
