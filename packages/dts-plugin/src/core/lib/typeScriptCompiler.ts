import ansiColors from 'ansi-colors';
import {
  ensureDirSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'fs-extra';
import { randomUUID } from 'crypto';
import { TEMP_DIR } from '@module-federation/sdk';
import {
  dirname,
  join,
  normalize,
  relative,
  resolve,
  sep,
  extname,
  isAbsolute,
} from 'path';
import typescript from 'typescript';
import { ThirdPartyExtractor } from '@module-federation/third-party-dts-extractor';
import { execSync } from 'child_process';

import { RemoteOptions } from '../interfaces/RemoteOptions';
import { TsConfigJson } from '../interfaces/TsConfigJson';
import { fileLog } from '../../server';

const STARTS_WITH_SLASH = /^\//;

const DEFINITION_FILE_EXTENSION = '.d.ts';

const reportCompileDiagnostic = (diagnostic: typescript.Diagnostic): void => {
  const { line } = diagnostic.file!.getLineAndCharacterOfPosition(
    diagnostic.start!,
  );

  console.error(
    ansiColors.red(
      `TS Error ${diagnostic.code}':' ${typescript.flattenDiagnosticMessageText(
        diagnostic.messageText,
        typescript.sys.newLine,
      )}`,
    ),
  );
  console.error(
    ansiColors.red(
      `         at ${diagnostic.file!.fileName}:${
        line + 1
      } typescript.sys.newLine`,
    ),
  );
};

export const retrieveMfTypesPath = (
  tsConfig: TsConfigJson,
  remoteOptions: Required<RemoteOptions>,
) =>
  normalize(
    tsConfig.compilerOptions.outDir!.replace(
      remoteOptions.compiledTypesFolder,
      '',
    ),
  );

export const retrieveOriginalOutDir = (
  tsConfig: TsConfigJson,
  remoteOptions: Required<RemoteOptions>,
) =>
  normalize(
    tsConfig.compilerOptions
      .outDir!.replace(remoteOptions.compiledTypesFolder, '')
      .replace(remoteOptions.typesFolder, ''),
  );

export const retrieveMfAPITypesPath = (
  tsConfig: TsConfigJson,
  remoteOptions: Required<RemoteOptions>,
) =>
  join(
    retrieveOriginalOutDir(tsConfig, remoteOptions),
    `${remoteOptions.typesFolder}.d.ts`,
  );

function writeTempTsConfig(tsConfig: TsConfigJson, context: string) {
  const tempTsConfigJsonPath = resolve(
    context,
    'node_modules',
    TEMP_DIR,
    `tsconfig.${randomUUID()}.json`,
  );
  ensureDirSync(dirname(tempTsConfigJsonPath));
  writeFileSync(tempTsConfigJsonPath, JSON.stringify(tsConfig, null, 2));
  fileLog(
    `writeTempTsConfig:  ${JSON.stringify(tsConfig, null, 2)}`,
    'writeTempTsConfig',
    'info',
  );
  return tempTsConfigJsonPath;
}

const removeExt = (f: string): string => {
  const ext = extname(f);
  const regexPattern = new RegExp(`\\${ext}$`);
  return f.replace(regexPattern, '');
};

function getExposeKey(options: {
  filePath: string;
  rootDir: string;
  outDir: string;
  mapExposeToEntry: Record<string, string>;
}) {
  const { filePath, rootDir, outDir, mapExposeToEntry } = options;
  const relativeFilePath = removeExt(relative(rootDir, filePath));
  return mapExposeToEntry[relativeFilePath];
}

const processTypesFile = (options: {
  outDir: string;
  filePath: string;
  rootDir: string;
  mfTypePath: string;
  cb: (dts: string) => void;
  mapExposeToEntry: Record<string, string>;
}) => {
  const { outDir, filePath, rootDir, cb, mapExposeToEntry, mfTypePath } =
    options;
  if (lstatSync(filePath).isDirectory()) {
    readdirSync(filePath).forEach((file) =>
      processTypesFile({
        ...options,
        filePath: join(filePath, file),
      }),
    );
  } else if (filePath.endsWith('.d.ts')) {
    const exposeKey = getExposeKey({
      filePath,
      rootDir,
      outDir,
      mapExposeToEntry,
    });
    if (exposeKey) {
      const sourceEntry = exposeKey === '.' ? 'index' : exposeKey;
      const mfeTypeEntry = join(
        mfTypePath,
        `${sourceEntry}${DEFINITION_FILE_EXTENSION}`,
      );
      const mfeTypeEntryDirectory = dirname(mfeTypeEntry);
      const relativePathToOutput = relative(mfeTypeEntryDirectory, filePath)
        .replace(DEFINITION_FILE_EXTENSION, '')
        .replace(STARTS_WITH_SLASH, '')
        .split(sep) // Windows platform-specific file system path fix
        .join('/');
      writeFileSync(
        mfeTypeEntry,
        `export * from './${relativePathToOutput}';\nexport { default } from './${relativePathToOutput}';`,
      );
    }
    const content = readFileSync(filePath, 'utf8');
    cb(content);
  }
};

export const compileTs = (
  mapComponentsToExpose: Record<string, string>,
  tsConfig: TsConfigJson,
  remoteOptions: Required<RemoteOptions>,
) => {
  const { compilerOptions } = tsConfig;
  const tempTsConfigJsonPath = writeTempTsConfig(
    tsConfig,
    remoteOptions.context,
  );
  const mfTypePath = retrieveMfTypesPath(tsConfig, remoteOptions);
  const thirdPartyExtractor = new ThirdPartyExtractor(
    resolve(mfTypePath, 'node_modules'),
    remoteOptions.context,
  );

  execSync(
    `npx ${remoteOptions.compilerInstance} --project ${tempTsConfigJsonPath}`,
    { stdio: 'inherit' },
  );
  const mapExposeToEntry = Object.fromEntries(
    Object.entries(mapComponentsToExpose).map(([exposed, filename]) => {
      const normalizedFileName = normalize(filename);
      let relativeFileName = '';
      if (isAbsolute(normalizedFileName)) {
        relativeFileName = relative(
          tsConfig.compilerOptions.rootDir,
          normalizedFileName,
        );
      } else {
        relativeFileName = relative(
          tsConfig.compilerOptions.rootDir,
          resolve(remoteOptions.context, normalizedFileName),
        );
      }

      return [removeExt(relativeFileName), exposed];
    }),
  );

  const cb = remoteOptions.extractThirdParty
    ? thirdPartyExtractor.collectPkgs.bind(thirdPartyExtractor)
    : () => undefined;

  processTypesFile({
    outDir: compilerOptions.outDir,
    filePath: tempTsConfigJsonPath,
    rootDir: compilerOptions.rootDir,
    mfTypePath,
    cb,
    mapExposeToEntry,
  });

  if (remoteOptions.extractThirdParty) {
    thirdPartyExtractor.copyDts();
  }

  rmSync(tempTsConfigJsonPath);
};
