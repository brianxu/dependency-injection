var gulp = require('gulp');
var runSequence = require('run-sequence');
var to5 = require('gulp-babel');
var paths = require('../paths');
var compilerOptions = require('../babel-options');
var assign = Object.assign || require('object.assign');

gulp.task('build-es6', function () {
  return gulp.src(paths.source)
    .pipe(gulp.dest(paths.output + 'es6'));
});

gulp.task('build-commonjs', function () {
  return gulp.src(paths.source)
    .pipe(to5(assign({}, compilerOptions, {modules:'common'})))
    .pipe(gulp.dest(paths.output + 'commonjs'));
});

gulp.task('build-amd', function () {
  return gulp.src(paths.source)
    .pipe(to5(assign({}, compilerOptions, {modules:'amd'})))
    .pipe(gulp.dest(paths.output + 'amd'));
});

gulp.task('build-system', function () {
  return gulp.src(paths.source)
    .pipe(to5(assign({}, compilerOptions, {modules:'system'})))
    .pipe(gulp.dest(paths.output + 'system'));
});

gulp.task('build-es5', function () {
    var Builder = require('systemjs-builder');
    var builder = new Builder({transpiler: 'babel'});
    // console.log(builder)
    builder.loadConfig('./config.js')
        .then(function() {
            builder.buildSFX('./src/exports', paths.output+ 'es5/di.js')
            .then(function() {
              console.log('Build complete');
            })
            .catch(function(err) {
              console.log('Build error');
              console.log(err);
            });
        });
});

gulp.task('build', function(callback) {
  return runSequence(
    'clean',
    ['build-es5'],
    callback
  );
});
