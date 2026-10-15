const config: import('lint-staged').Configuration = {
    'src/**/*.{mts,ts}': (files) => 
        `cross-env NODE_OPTIONS=--experimental-strip-types prettier --write ${files.join(' ')}`,
};

export default config;
