import { type Config } from 'prettier';

const config: Config = {
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: true,
    quoteProps: 'as-needed',
    trailingComma: 'es5',
    bracketSpacing: true,
    bracketSameLine: false,
    arrowParens: 'always',
    proseWrap: 'preserve',
    htmlWhitespaceSensitivity: 'css',
    endOfLine: 'lf',
    embeddedLanguageFormatting: 'auto',
    plugins: ['@trivago/prettier-plugin-sort-imports'],
};

export default config;
