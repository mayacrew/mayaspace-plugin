/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	roots: ['<rootDir>/src'],
	transform: {
		'^.+\\.tsx?$': ['ts-jest', {
			tsconfig: {
				module: 'commonjs',
				target: 'es2018',
				esModuleInterop: true,
				moduleResolution: 'node',
				strictNullChecks: true,
				noImplicitAny: true,
				lib: ['DOM', 'ES2018'],
			},
		}],
	},
	testMatch: ['**/*.test.ts'],
	verbose: true,
};
