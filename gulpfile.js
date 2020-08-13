const gulp = require('gulp')
const gutil = require('gulp-util')
require('gulp-clean')
const gmocha = require('gulp-mocha')
const typescript = require('gulp-typescript')
const sourcemaps = require('gulp-sourcemaps')
require('ts-node/register/transpile-only')
const tsProject = typescript.createProject('tsconfig.json')

const OPTIONS = {
	dirs: {
		sources: './lib',
		build: './build'
	}
}

gulp.task('clean', () => {
	return gulp.src(OPTIONS.dirs.build, { read: false })
})

gulp.task('test', () =>
	gulp.src('tests/tests.ts')
	.pipe(gmocha({
		compilers: [
			'ts:ts-node/register/transpile-only'
		]
	}))
)

gulp.task('typescript', () =>
	tsProject.src()
	.pipe(sourcemaps.init())
	.pipe(tsProject()).on('error', gutil.log)
	.pipe(sourcemaps.write('./', {
		includeContent: true,
		sourceRoot: OPTIONS.dirs.sources,
		rootDir: '.'
	}))
	.pipe(gulp.dest(OPTIONS.dirs.build))
)

gulp.task('build', gulp.series('typescript'))
gulp.task('default', gulp.series('build'))
