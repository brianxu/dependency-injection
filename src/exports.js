var globalScope = globalScope || window;
var DI = globalScope.DI || {};

// Stick on the modules that need to be exported.
// You only need to require the top-level modules, browserify
// will walk the dependency graph and load everything correctly
import {
    Registration,
    TransientRegistration,
    SingletonRegistration,
    Resolver,
    Lazy,
    All,
    Optional,
    Parent,
    InstanceActivator,
    FactoryActivator,
    Container,
    inject,
    transient,
    singleton,
    factory

} from './index';

import {Decorators, Metadata} from 'aurelia-metadata';

DI.Registration = Registration
DI.TransientRegistration = TransientRegistration
DI.SingletonRegistration = SingletonRegistration
DI.Resolver = Resolver
DI.Lazy = Lazy
DI.All = All
DI.Optional = Optional
DI.Parent = Parent
DI.InstanceActivator = InstanceActivator
DI.FactoryActivator = FactoryActivator
DI.Container = Container
DI.inject = inject
DI.transient = transient
DI.singleton = singleton
DI.factory = factory

DI.Decorators = Decorators
DI.Metadata = Metadata

// Replace/Create the global namespace
globalScope.DI = DI;
