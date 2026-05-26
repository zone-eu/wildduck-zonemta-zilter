'use strict';

const { defineConfig } = require('eslint/config');
const { builtinRules } = require('eslint/use-at-your-own-risk');
const nodemailer = require('eslint-config-nodemailer');
const prettier = require('eslint-config-prettier/flat');

const recommendedRules = Object.fromEntries(
    Array.from(builtinRules)
        .filter(([, rule]) => rule.meta && rule.meta.docs && rule.meta.docs.recommended)
        .map(([ruleId]) => [ruleId, 'error'])
);

module.exports = defineConfig([
    {
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'commonjs',
            globals: {
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                clearImmediate: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                console: 'readonly',
                exports: 'writable',
                global: 'readonly',
                module: 'readonly',
                process: 'readonly',
                require: 'readonly',
                setImmediate: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly',
                afterEach: 'readonly',
                beforeEach: 'readonly',
                describe: 'readonly',
                it: 'readonly'
            }
        },
        rules: {
            ...recommendedRules,
            ...nodemailer.rules
        }
    },
    prettier,
    {
        rules: {
            indent: 0,
            'no-await-in-loop': 0,
            'require-atomic-updates': 0,
            'no-prototype-builtins': 0
        }
    }
]);
