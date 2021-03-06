'use strict';

exports.__esModule = true;
exports.autoinject = autoinject;
exports.inject = inject;
exports.registration = registration;
exports.transient = transient;
exports.singleton = singleton;
exports.instanceActivator = instanceActivator;
exports.factory = factory;

var _Decorators$Metadata = require('aurelia-metadata');

var _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters = require('./metadata');

exports.TransientRegistration = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.TransientRegistration;
exports.SingletonRegistration = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.SingletonRegistration;
exports.Resolver = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.Resolver;
exports.Lazy = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.Lazy;
exports.All = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.All;
exports.Optional = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.Optional;
exports.Parent = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.Parent;
exports.ClassActivator = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.ClassActivator;
exports.FactoryActivator = _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.FactoryActivator;

var _Container = require('./container');

exports.Container = _Container.Container;

function autoinject(target) {
  var deco = function deco(target) {
    target.inject = Reflect.getOwnMetadata(_Decorators$Metadata.Metadata.paramTypes, target) || _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.emptyParameters;
  };

  return target ? deco(target) : deco;
}

function inject() {
  for (var _len = arguments.length, rest = Array(_len), _key = 0; _key < _len; _key++) {
    rest[_key] = arguments[_key];
  }

  return function (target) {
    target.inject = rest;
  };
}

function registration(value) {
  return function (target) {
    Reflect.defineMetadata(_Decorators$Metadata.Metadata.registration, value, target);
  };
}

function transient(key) {
  return registration(new _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.TransientRegistration(key));
}

function singleton(keyOrRegisterInChild) {
  var registerInChild = arguments[1] === undefined ? false : arguments[1];

  return registration(new _TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.SingletonRegistration(keyOrRegisterInChild, registerInChild));
}

function instanceActivator(value) {
  return function (target) {
    Reflect.defineMetadata(_Decorators$Metadata.Metadata.instanceActivator, value, target);
  };
}

function factory() {
  return instanceActivator(_TransientRegistration$SingletonRegistration$FactoryActivator$emptyParameters.FactoryActivator.instance);
}

_Decorators$Metadata.Decorators.configure.simpleDecorator('autoinject', autoinject);
_Decorators$Metadata.Decorators.configure.parameterizedDecorator('inject', inject);
_Decorators$Metadata.Decorators.configure.parameterizedDecorator('registration', registration);
_Decorators$Metadata.Decorators.configure.parameterizedDecorator('transient', transient);
_Decorators$Metadata.Decorators.configure.parameterizedDecorator('singleton', singleton);
_Decorators$Metadata.Decorators.configure.parameterizedDecorator('instanceActivator', instanceActivator);
_Decorators$Metadata.Decorators.configure.parameterizedDecorator('factory', factory);