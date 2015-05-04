(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";

    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        if (depEntry.module.exports && depEntry.module.exports.__esModule)
          depExports = depEntry.module.exports;
        else
          depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.module.exports;

    if (!module || !entry.declarative && module.__esModule !== true)
      module = { 'default': module, __useDefault: true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(mains, declare) {

    var System;
    var System = {
      register: register, 
      get: load, 
      set: function(name, module) {
        modules[name] = module; 
      },
      newModule: function(module) {
        return module;
      },
      global: global 
    };
    System.set('@empty', {});

    declare(System);

    for (var i = 0; i < mains.length; i++)
      load(mains[i]);
  }

})(typeof window != 'undefined' ? window : global)
/* (['mainModule'], function(System) {
  System.register(...);
}); */

(['src/exports'], function(System) {

System.register("npm:core-js@0.9.5/modules/$.fw", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = true;
    $.path = $.g;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.dom-create", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      document = $.g.document,
      isObject = $.isObject,
      is = isObject(document) && isObject(document.createElement);
  module.exports = function(it) {
    return is ? document.createElement(it) : {};
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.uid", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var sid = 0;
  function uid(key) {
    return 'Symbol(' + key + ')_' + (++sid + Math.random()).toString(36);
  }
  uid.safe = require("npm:core-js@0.9.5/modules/$").g.Symbol || uid;
  module.exports = uid;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.def", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      global = $.g,
      core = $.core,
      isFunction = $.isFunction;
  function ctx(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  }
  global.core = core;
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  function $def(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {}).prototype,
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      out = (own ? target : source)[key];
      if (type & $def.B && own)
        exp = ctx(out, global);
      else
        exp = type & $def.P && isFunction(out) ? ctx(Function.call, out) : out;
      if (target && !own) {
        if (isGlobal)
          target[key] = out;
        else
          delete target[key] && $.hide(target, key, out);
      }
      if (exports[key] != out)
        $.hide(exports, key, exp);
    }
  }
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.invoke", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function(fn, args, that) {
    var un = that === undefined;
    switch (args.length) {
      case 0:
        return un ? fn() : fn.call(that);
      case 1:
        return un ? fn(args[0]) : fn.call(that, args[0]);
      case 2:
        return un ? fn(args[0], args[1]) : fn.call(that, args[0], args[1]);
      case 3:
        return un ? fn(args[0], args[1], args[2]) : fn.call(that, args[0], args[1], args[2]);
      case 4:
        return un ? fn(args[0], args[1], args[2], args[3]) : fn.call(that, args[0], args[1], args[2], args[3]);
      case 5:
        return un ? fn(args[0], args[1], args[2], args[3], args[4]) : fn.call(that, args[0], args[1], args[2], args[3], args[4]);
    }
    return fn.apply(that, args);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.assert", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$");
  function assert(condition, msg1, msg2) {
    if (!condition)
      throw TypeError(msg2 ? msg1 + msg2 : msg1);
  }
  assert.def = $.assertDefined;
  assert.fn = function(it) {
    if (!$.isFunction(it))
      throw TypeError(it + ' is not a function!');
    return it;
  };
  assert.obj = function(it) {
    if (!$.isObject(it))
      throw TypeError(it + ' is not an object!');
    return it;
  };
  assert.inst = function(it, Constructor, name) {
    if (!(it instanceof Constructor))
      throw TypeError(name + ": use the 'new' operator!");
    return it;
  };
  module.exports = assert;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.array-includes", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$");
  module.exports = function(IS_INCLUDES) {
    return function($this, el, fromIndex) {
      var O = $.toObject($this),
          length = $.toLength(O.length),
          index = $.toIndex(fromIndex, length),
          value;
      if (IS_INCLUDES && el != el)
        while (length > index) {
          value = O[index++];
          if (value != value)
            return true;
        }
      else
        for (; length > index; index++)
          if (IS_INCLUDES || index in O) {
            if (O[index] === el)
              return IS_INCLUDES || index;
          }
      return !IS_INCLUDES && -1;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.replacer", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  module.exports = function(regExp, replace, isStatic) {
    var replacer = replace === Object(replace) ? function(part) {
      return replace[part];
    } : replace;
    return function(it) {
      return String(isStatic ? it : this).replace(regExp, replacer);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.throws", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function(exec) {
    try {
      exec();
      return false;
    } catch (e) {
      return true;
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.keyof", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$");
  module.exports = function(object, el) {
    var O = $.toObject(object),
        keys = $.getKeys(O),
        length = keys.length,
        index = 0,
        key;
    while (length > index)
      if (O[key = keys[index++]] === el)
        return key;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.enum-keys", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$");
  module.exports = function(it) {
    var keys = $.getKeys(it),
        getDesc = $.getDesc,
        getSymbols = $.getSymbols;
    if (getSymbols)
      $.each.call(getSymbols(it), function(key) {
        if (getDesc(it, key).enumerable)
          keys.push(key);
      });
    return keys;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.assign", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.enum-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      enumKeys = require("npm:core-js@0.9.5/modules/$.enum-keys");
  module.exports = Object.assign || function assign(target, source) {
    var T = Object($.assertDefined(target)),
        l = arguments.length,
        i = 1;
    while (l > i) {
      var S = $.ES5Object(arguments[i++]),
          keys = enumKeys(S),
          length = keys.length,
          j = 0,
          key;
      while (length > j)
        T[key = keys[j++]] = S[key];
    }
    return T;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.object.is", ["npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.S, 'Object', {is: function is(x, y) {
      return x === y ? x !== 0 || 1 / x === 1 / y : x != x && y != y;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.set-proto", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      assert = require("npm:core-js@0.9.5/modules/$.assert");
  function check(O, proto) {
    assert.obj(O);
    assert(proto === null || $.isObject(proto), proto, ": can't set as prototype!");
  }
  module.exports = {
    set: Object.setPrototypeOf || ('__proto__' in {} ? function(buggy, set) {
      try {
        set = require("npm:core-js@0.9.5/modules/$.ctx")(Function.call, $.getDesc(Object.prototype, '__proto__').set, 2);
        set({}, []);
      } catch (e) {
        buggy = true;
      }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy)
          O.__proto__ = proto;
        else
          set(O, proto);
        return O;
      };
    }() : undefined),
    check: check
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.object.to-string", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      tmp = {};
  tmp[require("npm:core-js@0.9.5/modules/$.wks")('toStringTag')] = 'z';
  if ($.FW && cof(tmp) != 'z')
    $.hide(Object.prototype, 'toString', function toString() {
      return '[object ' + cof.classof(this) + ']';
    });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.object.statics-accept-primitives", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      isObject = $.isObject,
      toObject = $.toObject;
  function wrapObjectMethod(METHOD, MODE) {
    var fn = ($.core.Object || {})[METHOD] || Object[METHOD],
        f = 0,
        o = {};
    o[METHOD] = MODE == 1 ? function(it) {
      return isObject(it) ? fn(it) : it;
    } : MODE == 2 ? function(it) {
      return isObject(it) ? fn(it) : true;
    } : MODE == 3 ? function(it) {
      return isObject(it) ? fn(it) : false;
    } : MODE == 4 ? function getOwnPropertyDescriptor(it, key) {
      return fn(toObject(it), key);
    } : MODE == 5 ? function getPrototypeOf(it) {
      return fn(Object($.assertDefined(it)));
    } : function(it) {
      return fn(toObject(it));
    };
    try {
      fn('z');
    } catch (e) {
      f = 1;
    }
    $def($def.S + $def.F * f, 'Object', o);
  }
  wrapObjectMethod('freeze', 1);
  wrapObjectMethod('seal', 1);
  wrapObjectMethod('preventExtensions', 1);
  wrapObjectMethod('isFrozen', 2);
  wrapObjectMethod('isSealed', 2);
  wrapObjectMethod('isExtensible', 3);
  wrapObjectMethod('getOwnPropertyDescriptor', 4);
  wrapObjectMethod('getPrototypeOf', 5);
  wrapObjectMethod('keys');
  wrapObjectMethod('getOwnPropertyNames');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.function.name", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      NAME = 'name',
      setDesc = $.setDesc,
      FunctionProto = Function.prototype;
  NAME in FunctionProto || $.FW && $.DESC && setDesc(FunctionProto, NAME, {
    configurable: true,
    get: function() {
      var match = String(this).match(/^\s*function ([^ (]*)/),
          name = match ? match[1] : '';
      $.has(this, NAME) || setDesc(this, NAME, $.desc(5, name));
      return name;
    },
    set: function(value) {
      $.has(this, NAME) || setDesc(this, NAME, $.desc(0, value));
    }
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.function.has-instance", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      HAS_INSTANCE = require("npm:core-js@0.9.5/modules/$.wks")('hasInstance'),
      FunctionProto = Function.prototype;
  if (!(HAS_INSTANCE in FunctionProto))
    $.setDesc(FunctionProto, HAS_INSTANCE, {value: function(O) {
        if (!$.isFunction(this) || !$.isObject(O))
          return false;
        if (!$.isObject(this.prototype))
          return O instanceof this;
        while (O = $.getProto(O))
          if (this.prototype === O)
            return true;
        return false;
      }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.number.constructor", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      isObject = $.isObject,
      isFunction = $.isFunction,
      NUMBER = 'Number',
      $Number = $.g[NUMBER],
      Base = $Number,
      proto = $Number.prototype;
  function toPrimitive(it) {
    var fn,
        val;
    if (isFunction(fn = it.valueOf) && !isObject(val = fn.call(it)))
      return val;
    if (isFunction(fn = it.toString) && !isObject(val = fn.call(it)))
      return val;
    throw TypeError("Can't convert object to number");
  }
  function toNumber(it) {
    if (isObject(it))
      it = toPrimitive(it);
    if (typeof it == 'string' && it.length > 2 && it.charCodeAt(0) == 48) {
      var binary = false;
      switch (it.charCodeAt(1)) {
        case 66:
        case 98:
          binary = true;
        case 79:
        case 111:
          return parseInt(it.slice(2), binary ? 2 : 8);
      }
    }
    return +it;
  }
  if ($.FW && !($Number('0o1') && $Number('0b1'))) {
    $Number = function Number(it) {
      return this instanceof $Number ? new Base(toNumber(it)) : toNumber(it);
    };
    $.each.call($.DESC ? $.getNames(Base) : ('MAX_VALUE,MIN_VALUE,NaN,NEGATIVE_INFINITY,POSITIVE_INFINITY,' + 'EPSILON,isFinite,isInteger,isNaN,isSafeInteger,MAX_SAFE_INTEGER,' + 'MIN_SAFE_INTEGER,parseFloat,parseInt,isInteger').split(','), function(key) {
      if ($.has(Base, key) && !$.has($Number, key)) {
        $.setDesc($Number, key, $.getDesc(Base, key));
      }
    });
    $Number.prototype = proto;
    proto.constructor = $Number;
    $.hide($.g, NUMBER, $Number);
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.number.statics", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      abs = Math.abs,
      floor = Math.floor,
      _isFinite = $.g.isFinite,
      MAX_SAFE_INTEGER = 0x1fffffffffffff;
  function isInteger(it) {
    return !$.isObject(it) && _isFinite(it) && floor(it) === it;
  }
  $def($def.S, 'Number', {
    EPSILON: Math.pow(2, -52),
    isFinite: function isFinite(it) {
      return typeof it == 'number' && _isFinite(it);
    },
    isInteger: isInteger,
    isNaN: function isNaN(number) {
      return number != number;
    },
    isSafeInteger: function isSafeInteger(number) {
      return isInteger(number) && abs(number) <= MAX_SAFE_INTEGER;
    },
    MAX_SAFE_INTEGER: MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: -MAX_SAFE_INTEGER,
    parseFloat: parseFloat,
    parseInt: parseInt
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.math", ["npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Infinity = 1 / 0,
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      E = Math.E,
      pow = Math.pow,
      abs = Math.abs,
      exp = Math.exp,
      log = Math.log,
      sqrt = Math.sqrt,
      ceil = Math.ceil,
      floor = Math.floor,
      EPSILON = pow(2, -52),
      EPSILON32 = pow(2, -23),
      MAX32 = pow(2, 127) * (2 - EPSILON32),
      MIN32 = pow(2, -126);
  function roundTiesToEven(n) {
    return n + 1 / EPSILON - 1 / EPSILON;
  }
  function sign(x) {
    return (x = +x) == 0 || x != x ? x : x < 0 ? -1 : 1;
  }
  function asinh(x) {
    return !isFinite(x = +x) || x == 0 ? x : x < 0 ? -asinh(-x) : log(x + sqrt(x * x + 1));
  }
  function expm1(x) {
    return (x = +x) == 0 ? x : x > -1e-6 && x < 1e-6 ? x + x * x / 2 : exp(x) - 1;
  }
  $def($def.S, 'Math', {
    acosh: function acosh(x) {
      return (x = +x) < 1 ? NaN : isFinite(x) ? log(x / E + sqrt(x + 1) * sqrt(x - 1) / E) + 1 : x;
    },
    asinh: asinh,
    atanh: function atanh(x) {
      return (x = +x) == 0 ? x : log((1 + x) / (1 - x)) / 2;
    },
    cbrt: function cbrt(x) {
      return sign(x = +x) * pow(abs(x), 1 / 3);
    },
    clz32: function clz32(x) {
      return (x >>>= 0) ? 31 - floor(log(x + 0.5) * Math.LOG2E) : 32;
    },
    cosh: function cosh(x) {
      return (exp(x = +x) + exp(-x)) / 2;
    },
    expm1: expm1,
    fround: function fround(x) {
      var $abs = abs(x),
          $sign = sign(x),
          a,
          result;
      if ($abs < MIN32)
        return $sign * roundTiesToEven($abs / MIN32 / EPSILON32) * MIN32 * EPSILON32;
      a = (1 + EPSILON32 / EPSILON) * $abs;
      result = a - (a - $abs);
      if (result > MAX32 || result != result)
        return $sign * Infinity;
      return $sign * result;
    },
    hypot: function hypot(value1, value2) {
      var sum = 0,
          len1 = arguments.length,
          len2 = len1,
          args = Array(len1),
          larg = -Infinity,
          arg;
      while (len1--) {
        arg = args[len1] = +arguments[len1];
        if (arg == Infinity || arg == -Infinity)
          return Infinity;
        if (arg > larg)
          larg = arg;
      }
      larg = arg || 1;
      while (len2--)
        sum += pow(args[len2] / larg, 2);
      return larg * sqrt(sum);
    },
    imul: function imul(x, y) {
      var UInt16 = 0xffff,
          xn = +x,
          yn = +y,
          xl = UInt16 & xn,
          yl = UInt16 & yn;
      return 0 | xl * yl + ((UInt16 & xn >>> 16) * yl + xl * (UInt16 & yn >>> 16) << 16 >>> 0);
    },
    log1p: function log1p(x) {
      return (x = +x) > -1e-8 && x < 1e-8 ? x - x * x / 2 : log(1 + x);
    },
    log10: function log10(x) {
      return log(x) / Math.LN10;
    },
    log2: function log2(x) {
      return log(x) / Math.LN2;
    },
    sign: sign,
    sinh: function sinh(x) {
      return abs(x = +x) < 1 ? (expm1(x) - expm1(-x)) / 2 : (exp(x - 1) - exp(-x - 1)) * (E / 2);
    },
    tanh: function tanh(x) {
      var a = expm1(x = +x),
          b = expm1(-x);
      return a == Infinity ? 1 : b == Infinity ? -1 : (a - b) / (exp(x) + exp(-x));
    },
    trunc: function trunc(it) {
      return (it > 0 ? floor : ceil)(it);
    }
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.from-code-point", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      toIndex = require("npm:core-js@0.9.5/modules/$").toIndex,
      fromCharCode = String.fromCharCode;
  $def($def.S, 'String', {fromCodePoint: function fromCodePoint(x) {
      var res = [],
          len = arguments.length,
          i = 0,
          code;
      while (len > i) {
        code = +arguments[i++];
        if (toIndex(code, 0x10ffff) !== code)
          throw RangeError(code + ' is not a valid code point');
        res.push(code < 0x10000 ? fromCharCode(code) : fromCharCode(((code -= 0x10000) >> 10) + 0xd800, code % 0x400 + 0xdc00));
      }
      return res.join('');
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.raw", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.S, 'String', {raw: function raw(callSite) {
      var tpl = $.toObject(callSite.raw),
          len = $.toLength(tpl.length),
          sln = arguments.length,
          res = [],
          i = 0;
      while (len > i) {
        res.push(String(tpl[i++]));
        if (i < sln)
          res.push(String(arguments[i]));
      }
      return res.join('');
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.string-at", ["npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$");
  module.exports = function(TO_STRING) {
    return function(that, pos) {
      var s = String($.assertDefined(that)),
          i = $.toInteger(pos),
          l = s.length,
          a,
          b;
      if (i < 0 || i >= l)
        return TO_STRING ? '' : undefined;
      a = s.charCodeAt(i);
      return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.iter", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      assertObject = require("npm:core-js@0.9.5/modules/$.assert").obj,
      SYMBOL_ITERATOR = require("npm:core-js@0.9.5/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      Iterators = {},
      IteratorPrototype = {};
  setIterator(IteratorPrototype, $.that);
  function setIterator(O, value) {
    $.hide(O, SYMBOL_ITERATOR, value);
    if (FF_ITERATOR in [])
      $.hide(O, FF_ITERATOR, value);
  }
  module.exports = {
    BUGGY: 'keys' in [] && !('next' in [].keys()),
    Iterators: Iterators,
    step: function(done, value) {
      return {
        value: value,
        done: !!done
      };
    },
    is: function(it) {
      var O = Object(it),
          Symbol = $.g.Symbol,
          SYM = Symbol && Symbol.iterator || FF_ITERATOR;
      return SYM in O || SYMBOL_ITERATOR in O || $.has(Iterators, cof.classof(O));
    },
    get: function(it) {
      var Symbol = $.g.Symbol,
          ext = it[Symbol && Symbol.iterator || FF_ITERATOR],
          getIter = ext || it[SYMBOL_ITERATOR] || Iterators[cof.classof(it)];
      return assertObject(getIter.call(it));
    },
    set: setIterator,
    create: function(Constructor, NAME, next, proto) {
      Constructor.prototype = $.create(proto || IteratorPrototype, {next: $.desc(1, next)});
      cof.set(Constructor, NAME + ' Iterator');
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.iter-define", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      $ = require("npm:core-js@0.9.5/modules/$"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      $iter = require("npm:core-js@0.9.5/modules/$.iter"),
      SYMBOL_ITERATOR = require("npm:core-js@0.9.5/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      KEYS = 'keys',
      VALUES = 'values',
      Iterators = $iter.Iterators;
  module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
    $iter.create(Constructor, NAME, next);
    function createMethod(kind) {
      function $$(that) {
        return new Constructor(that, kind);
      }
      switch (kind) {
        case KEYS:
          return function keys() {
            return $$(this);
          };
        case VALUES:
          return function values() {
            return $$(this);
          };
      }
      return function entries() {
        return $$(this);
      };
    }
    var TAG = NAME + ' Iterator',
        proto = Base.prototype,
        _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
        _default = _native || createMethod(DEFAULT),
        methods,
        key;
    if (_native) {
      var IteratorPrototype = $.getProto(_default.call(new Base));
      cof.set(IteratorPrototype, TAG, true);
      if ($.FW && $.has(proto, FF_ITERATOR))
        $iter.set(IteratorPrototype, $.that);
    }
    if ($.FW)
      $iter.set(proto, _default);
    Iterators[NAME] = _default;
    Iterators[TAG] = $.that;
    if (DEFAULT) {
      methods = {
        keys: IS_SET ? _default : createMethod(KEYS),
        values: DEFAULT == VALUES ? _default : createMethod(VALUES),
        entries: DEFAULT != VALUES ? _default : createMethod('entries')
      };
      if (FORCE)
        for (key in methods) {
          if (!(key in proto))
            $.hide(proto, key, methods[key]);
        }
      else
        $def($def.P + $def.F * $iter.BUGGY, NAME, methods);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.code-point-at", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.string-at"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      $at = require("npm:core-js@0.9.5/modules/$.string-at")(false);
  $def($def.P, 'String', {codePointAt: function codePointAt(pos) {
      return $at(this, pos);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.ends-with", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.throws"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      toLength = $.toLength;
  $def($def.P + $def.F * !require("npm:core-js@0.9.5/modules/$.throws")(function() {
    'q'.endsWith(/./);
  }), 'String', {endsWith: function endsWith(searchString) {
      if (cof(searchString) == 'RegExp')
        throw TypeError();
      var that = String($.assertDefined(this)),
          endPosition = arguments[1],
          len = toLength(that.length),
          end = endPosition === undefined ? len : Math.min(toLength(endPosition), len);
      searchString += '';
      return that.slice(end - searchString.length, end) === searchString;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.includes", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.P, 'String', {includes: function includes(searchString) {
      if (cof(searchString) == 'RegExp')
        throw TypeError();
      return !!~String($.assertDefined(this)).indexOf(searchString, arguments[1]);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.repeat", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.P, 'String', {repeat: function repeat(count) {
      var str = String($.assertDefined(this)),
          res = '',
          n = $.toInteger(count);
      if (n < 0 || n == Infinity)
        throw RangeError("Count can't be negative");
      for (; n > 0; (n >>>= 1) && (str += str))
        if (n & 1)
          res += str;
      return res;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.starts-with", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.throws"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.P + $def.F * !require("npm:core-js@0.9.5/modules/$.throws")(function() {
    'q'.startsWith(/./);
  }), 'String', {startsWith: function startsWith(searchString) {
      if (cof(searchString) == 'RegExp')
        throw TypeError();
      var that = String($.assertDefined(this)),
          index = $.toLength(Math.min(arguments[1], that.length));
      searchString += '';
      return that.slice(index, index + searchString.length) === searchString;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.iter-call", ["npm:core-js@0.9.5/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertObject = require("npm:core-js@0.9.5/modules/$.assert").obj;
  function close(iterator) {
    var ret = iterator['return'];
    if (ret !== undefined)
      assertObject(ret.call(iterator));
  }
  function call(iterator, fn, value, entries) {
    try {
      return entries ? fn(assertObject(value)[0], value[1]) : fn(value);
    } catch (e) {
      close(iterator);
      throw e;
    }
  }
  call.close = close;
  module.exports = call;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.iter-detect", ["npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var SYMBOL_ITERATOR = require("npm:core-js@0.9.5/modules/$.wks")('iterator'),
      SAFE_CLOSING = false;
  try {
    var riter = [7][SYMBOL_ITERATOR]();
    riter['return'] = function() {
      SAFE_CLOSING = true;
    };
    Array.from(riter, function() {
      throw 2;
    });
  } catch (e) {}
  module.exports = function(exec) {
    if (!SAFE_CLOSING)
      return false;
    var safe = false;
    try {
      var arr = [7],
          iter = arr[SYMBOL_ITERATOR]();
      iter.next = function() {
        safe = true;
      };
      arr[SYMBOL_ITERATOR] = function() {
        return iter;
      };
      exec(arr);
    } catch (e) {}
    return safe;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.of", ["npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.S, 'Array', {of: function of() {
      var index = 0,
          length = arguments.length,
          result = new (typeof this == 'function' ? this : Array)(length);
      while (length > index)
        result[index] = arguments[index++];
      result.length = length;
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.unscope", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      UNSCOPABLES = require("npm:core-js@0.9.5/modules/$.wks")('unscopables');
  if ($.FW && !(UNSCOPABLES in []))
    $.hide(Array.prototype, UNSCOPABLES, {});
  module.exports = function(key) {
    if ($.FW)
      [][UNSCOPABLES][key] = true;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.species", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      SPECIES = require("npm:core-js@0.9.5/modules/$.wks")('species');
  module.exports = function(C) {
    if ($.DESC && !(SPECIES in C))
      $.setDesc(C, SPECIES, {
        configurable: true,
        get: $.that
      });
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.copy-within", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      toIndex = $.toIndex;
  $def($def.P, 'Array', {copyWithin: function copyWithin(target, start) {
      var O = Object($.assertDefined(this)),
          len = $.toLength(O.length),
          to = toIndex(target, len),
          from = toIndex(start, len),
          end = arguments[2],
          fin = end === undefined ? len : toIndex(end, len),
          count = Math.min(fin - from, len - to),
          inc = 1;
      if (from < to && to < from + count) {
        inc = -1;
        from = from + count - 1;
        to = to + count - 1;
      }
      while (count-- > 0) {
        if (from in O)
          O[to] = O[from];
        else
          delete O[to];
        to += inc;
        from += inc;
      }
      return O;
    }});
  require("npm:core-js@0.9.5/modules/$.unscope")('copyWithin');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.fill", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      toIndex = $.toIndex;
  $def($def.P, 'Array', {fill: function fill(value) {
      var O = Object($.assertDefined(this)),
          length = $.toLength(O.length),
          index = toIndex(arguments[1], length),
          end = arguments[2],
          endPos = end === undefined ? length : toIndex(end, length);
      while (endPos > index)
        O[index++] = value;
      return O;
    }});
  require("npm:core-js@0.9.5/modules/$.unscope")('fill');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.find", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.array-methods", "npm:core-js@0.9.5/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var KEY = 'find',
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      forced = true,
      $find = require("npm:core-js@0.9.5/modules/$.array-methods")(5);
  if (KEY in [])
    Array(1)[KEY](function() {
      forced = false;
    });
  $def($def.P + $def.F * forced, 'Array', {find: function find(callbackfn) {
      return $find(this, callbackfn, arguments[1]);
    }});
  require("npm:core-js@0.9.5/modules/$.unscope")(KEY);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.find-index", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.array-methods", "npm:core-js@0.9.5/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var KEY = 'findIndex',
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      forced = true,
      $find = require("npm:core-js@0.9.5/modules/$.array-methods")(6);
  if (KEY in [])
    Array(1)[KEY](function() {
      forced = false;
    });
  $def($def.P + $def.F * forced, 'Array', {findIndex: function findIndex(callbackfn) {
      return $find(this, callbackfn, arguments[1]);
    }});
  require("npm:core-js@0.9.5/modules/$.unscope")(KEY);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.regexp", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.replacer", "npm:core-js@0.9.5/modules/$.species"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      $RegExp = $.g.RegExp,
      Base = $RegExp,
      proto = $RegExp.prototype,
      re = /a/g,
      CORRECT_NEW = new $RegExp(re) !== re,
      ALLOWS_RE_WITH_FLAGS = function() {
        try {
          return $RegExp(re, 'i') == '/a/i';
        } catch (e) {}
      }();
  if ($.FW && $.DESC) {
    if (!CORRECT_NEW || !ALLOWS_RE_WITH_FLAGS) {
      $RegExp = function RegExp(pattern, flags) {
        var patternIsRegExp = cof(pattern) == 'RegExp',
            flagsIsUndefined = flags === undefined;
        if (!(this instanceof $RegExp) && patternIsRegExp && flagsIsUndefined)
          return pattern;
        return CORRECT_NEW ? new Base(patternIsRegExp && !flagsIsUndefined ? pattern.source : pattern, flags) : new Base(patternIsRegExp ? pattern.source : pattern, patternIsRegExp && flagsIsUndefined ? pattern.flags : flags);
      };
      $.each.call($.getNames(Base), function(key) {
        key in $RegExp || $.setDesc($RegExp, key, {
          configurable: true,
          get: function() {
            return Base[key];
          },
          set: function(it) {
            Base[key] = it;
          }
        });
      });
      proto.constructor = $RegExp;
      $RegExp.prototype = proto;
      $.hide($.g, 'RegExp', $RegExp);
    }
    if (/./g.flags != 'g')
      $.setDesc(proto, 'flags', {
        configurable: true,
        get: require("npm:core-js@0.9.5/modules/$.replacer")(/^.*\/(\w*)$/, '$1')
      });
  }
  require("npm:core-js@0.9.5/modules/$.species")($RegExp);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.for-of", ["npm:core-js@0.9.5/modules/$.ctx", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.iter-call"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ctx = require("npm:core-js@0.9.5/modules/$.ctx"),
      get = require("npm:core-js@0.9.5/modules/$.iter").get,
      call = require("npm:core-js@0.9.5/modules/$.iter-call");
  module.exports = function(iterable, entries, fn, that) {
    var iterator = get(iterable),
        f = ctx(fn, that, entries ? 2 : 1),
        step;
    while (!(step = iterator.next()).done) {
      if (call(iterator, f, step.value, entries) === false) {
        return call.close(iterator);
      }
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:process@0.10.1/browser", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  function drainQueue() {
    if (draining) {
      return ;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      var i = -1;
      while (++i < len) {
        currentQueue[i]();
      }
      len = queue.length;
    }
    draining = false;
  }
  process.nextTick = function(fun) {
    queue.push(fun);
    if (!draining) {
      setTimeout(drainQueue, 0);
    }
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.collection-strong", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.ctx", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.for-of", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      ctx = require("npm:core-js@0.9.5/modules/$.ctx"),
      safe = require("npm:core-js@0.9.5/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.5/modules/$.assert"),
      forOf = require("npm:core-js@0.9.5/modules/$.for-of"),
      step = require("npm:core-js@0.9.5/modules/$.iter").step,
      has = $.has,
      set = $.set,
      isObject = $.isObject,
      hide = $.hide,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      ID = safe('id'),
      O1 = safe('O1'),
      LAST = safe('last'),
      FIRST = safe('first'),
      ITER = safe('iter'),
      SIZE = $.DESC ? safe('size') : 'size',
      id = 0;
  function fastKey(it, create) {
    if (!isObject(it))
      return (typeof it == 'string' ? 'S' : 'P') + it;
    if (isFrozen(it))
      return 'F';
    if (!has(it, ID)) {
      if (!create)
        return 'E';
      hide(it, ID, ++id);
    }
    return 'O' + it[ID];
  }
  function getEntry(that, key) {
    var index = fastKey(key),
        entry;
    if (index != 'F')
      return that[O1][index];
    for (entry = that[FIRST]; entry; entry = entry.n) {
      if (entry.k == key)
        return entry;
    }
  }
  module.exports = {
    getConstructor: function(NAME, IS_MAP, ADDER) {
      function C() {
        var that = assert.inst(this, C, NAME),
            iterable = arguments[0];
        set(that, O1, $.create(null));
        set(that, SIZE, 0);
        set(that, LAST, undefined);
        set(that, FIRST, undefined);
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      }
      $.mix(C.prototype, {
        clear: function clear() {
          for (var that = this,
              data = that[O1],
              entry = that[FIRST]; entry; entry = entry.n) {
            entry.r = true;
            if (entry.p)
              entry.p = entry.p.n = undefined;
            delete data[entry.i];
          }
          that[FIRST] = that[LAST] = undefined;
          that[SIZE] = 0;
        },
        'delete': function(key) {
          var that = this,
              entry = getEntry(that, key);
          if (entry) {
            var next = entry.n,
                prev = entry.p;
            delete that[O1][entry.i];
            entry.r = true;
            if (prev)
              prev.n = next;
            if (next)
              next.p = prev;
            if (that[FIRST] == entry)
              that[FIRST] = next;
            if (that[LAST] == entry)
              that[LAST] = prev;
            that[SIZE]--;
          }
          return !!entry;
        },
        forEach: function forEach(callbackfn) {
          var f = ctx(callbackfn, arguments[1], 3),
              entry;
          while (entry = entry ? entry.n : this[FIRST]) {
            f(entry.v, entry.k, this);
            while (entry && entry.r)
              entry = entry.p;
          }
        },
        has: function has(key) {
          return !!getEntry(this, key);
        }
      });
      if ($.DESC)
        $.setDesc(C.prototype, 'size', {get: function() {
            return assert.def(this[SIZE]);
          }});
      return C;
    },
    def: function(that, key, value) {
      var entry = getEntry(that, key),
          prev,
          index;
      if (entry) {
        entry.v = value;
      } else {
        that[LAST] = entry = {
          i: index = fastKey(key, true),
          k: key,
          v: value,
          p: prev = that[LAST],
          n: undefined,
          r: false
        };
        if (!that[FIRST])
          that[FIRST] = entry;
        if (prev)
          prev.n = entry;
        that[SIZE]++;
        if (index != 'F')
          that[O1][index] = entry;
      }
      return that;
    },
    getEntry: getEntry,
    setIter: function(C, NAME, IS_MAP) {
      require("npm:core-js@0.9.5/modules/$.iter-define")(C, NAME, function(iterated, kind) {
        set(this, ITER, {
          o: iterated,
          k: kind
        });
      }, function() {
        var iter = this[ITER],
            kind = iter.k,
            entry = iter.l;
        while (entry && entry.r)
          entry = entry.p;
        if (!iter.o || !(iter.l = entry = entry ? entry.n : iter.o[FIRST])) {
          iter.o = undefined;
          return step(1);
        }
        if (kind == 'keys')
          return step(0, entry.k);
        if (kind == 'values')
          return step(0, entry.v);
        return step(0, [entry.k, entry.v]);
      }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.collection", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.for-of", "npm:core-js@0.9.5/modules/$.species", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.iter-detect", "npm:core-js@0.9.5/modules/$.cof"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      BUGGY = require("npm:core-js@0.9.5/modules/$.iter").BUGGY,
      forOf = require("npm:core-js@0.9.5/modules/$.for-of"),
      species = require("npm:core-js@0.9.5/modules/$.species"),
      assertInstance = require("npm:core-js@0.9.5/modules/$.assert").inst;
  module.exports = function(NAME, methods, common, IS_MAP, IS_WEAK) {
    var Base = $.g[NAME],
        C = Base,
        ADDER = IS_MAP ? 'set' : 'add',
        proto = C && C.prototype,
        O = {};
    function fixMethod(KEY, CHAIN) {
      var method = proto[KEY];
      if ($.FW)
        proto[KEY] = function(a, b) {
          var result = method.call(this, a === 0 ? 0 : a, b);
          return CHAIN ? this : result;
        };
    }
    if (!$.isFunction(C) || !(IS_WEAK || !BUGGY && proto.forEach && proto.entries)) {
      C = common.getConstructor(NAME, IS_MAP, ADDER);
      $.mix(C.prototype, methods);
    } else {
      var inst = new C,
          chain = inst[ADDER](IS_WEAK ? {} : -0, 1),
          buggyZero;
      if (!require("npm:core-js@0.9.5/modules/$.iter-detect")(function(iter) {
        new C(iter);
      })) {
        C = function() {
          assertInstance(this, C, NAME);
          var that = new Base,
              iterable = arguments[0];
          if (iterable != undefined)
            forOf(iterable, IS_MAP, that[ADDER], that);
          return that;
        };
        C.prototype = proto;
        if ($.FW)
          proto.constructor = C;
      }
      IS_WEAK || inst.forEach(function(val, key) {
        buggyZero = 1 / key === -Infinity;
      });
      if (buggyZero) {
        fixMethod('delete');
        fixMethod('has');
        IS_MAP && fixMethod('get');
      }
      if (buggyZero || chain !== inst)
        fixMethod(ADDER, true);
    }
    require("npm:core-js@0.9.5/modules/$.cof").set(C, NAME);
    O[NAME] = C;
    $def($def.G + $def.W + $def.F * (C != Base), O);
    species(C);
    species($.core[NAME]);
    if (!IS_WEAK)
      common.setIter(C, NAME, IS_MAP);
    return C;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.set", ["npm:core-js@0.9.5/modules/$.collection-strong", "npm:core-js@0.9.5/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("npm:core-js@0.9.5/modules/$.collection-strong");
  require("npm:core-js@0.9.5/modules/$.collection")('Set', {add: function add(value) {
      return strong.def(this, value = value === 0 ? 0 : value, value);
    }}, strong);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.collection-weak", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.for-of", "npm:core-js@0.9.5/modules/$.array-methods"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      safe = require("npm:core-js@0.9.5/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.5/modules/$.assert"),
      forOf = require("npm:core-js@0.9.5/modules/$.for-of"),
      _has = $.has,
      isObject = $.isObject,
      hide = $.hide,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      id = 0,
      ID = safe('id'),
      WEAK = safe('weak'),
      LEAK = safe('leak'),
      method = require("npm:core-js@0.9.5/modules/$.array-methods"),
      find = method(5),
      findIndex = method(6);
  function findFrozen(store, key) {
    return find(store.array, function(it) {
      return it[0] === key;
    });
  }
  function leakStore(that) {
    return that[LEAK] || hide(that, LEAK, {
      array: [],
      get: function(key) {
        var entry = findFrozen(this, key);
        if (entry)
          return entry[1];
      },
      has: function(key) {
        return !!findFrozen(this, key);
      },
      set: function(key, value) {
        var entry = findFrozen(this, key);
        if (entry)
          entry[1] = value;
        else
          this.array.push([key, value]);
      },
      'delete': function(key) {
        var index = findIndex(this.array, function(it) {
          return it[0] === key;
        });
        if (~index)
          this.array.splice(index, 1);
        return !!~index;
      }
    })[LEAK];
  }
  module.exports = {
    getConstructor: function(NAME, IS_MAP, ADDER) {
      function C() {
        $.set(assert.inst(this, C, NAME), ID, id++);
        var iterable = arguments[0];
        if (iterable != undefined)
          forOf(iterable, IS_MAP, this[ADDER], this);
      }
      $.mix(C.prototype, {
        'delete': function(key) {
          if (!isObject(key))
            return false;
          if (isFrozen(key))
            return leakStore(this)['delete'](key);
          return _has(key, WEAK) && _has(key[WEAK], this[ID]) && delete key[WEAK][this[ID]];
        },
        has: function has(key) {
          if (!isObject(key))
            return false;
          if (isFrozen(key))
            return leakStore(this).has(key);
          return _has(key, WEAK) && _has(key[WEAK], this[ID]);
        }
      });
      return C;
    },
    def: function(that, key, value) {
      if (isFrozen(assert.obj(key))) {
        leakStore(that).set(key, value);
      } else {
        _has(key, WEAK) || hide(key, WEAK, {});
        key[WEAK][that[ID]] = value;
      }
      return that;
    },
    leakStore: leakStore,
    WEAK: WEAK,
    ID: ID
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.weak-set", ["npm:core-js@0.9.5/modules/$.collection-weak", "npm:core-js@0.9.5/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var weak = require("npm:core-js@0.9.5/modules/$.collection-weak");
  require("npm:core-js@0.9.5/modules/$.collection")('WeakSet', {add: function add(value) {
      return weak.def(this, value, true);
    }}, weak, false, true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.own-keys", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      assertObject = require("npm:core-js@0.9.5/modules/$.assert").obj;
  module.exports = function ownKeys(it) {
    assertObject(it);
    var keys = $.getNames(it),
        getSymbols = $.getSymbols;
    return getSymbols ? keys.concat(getSymbols(it)) : keys;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es7.array.includes", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.array-includes", "npm:core-js@0.9.5/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      $includes = require("npm:core-js@0.9.5/modules/$.array-includes")(true);
  $def($def.P, 'Array', {includes: function includes(el) {
      return $includes(this, el, arguments[1]);
    }});
  require("npm:core-js@0.9.5/modules/$.unscope")('includes');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es7.string.at", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.string-at"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      $at = require("npm:core-js@0.9.5/modules/$.string-at")(true);
  $def($def.P, 'String', {at: function at(pos) {
      return $at(this, pos);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es7.regexp.escape", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.replacer"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.S, 'RegExp', {escape: require("npm:core-js@0.9.5/modules/$.replacer")(/([\\\-[\]{}()*+?.,^$|])/g, '\\$1', true)});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es7.object.get-own-property-descriptors", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.own-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      ownKeys = require("npm:core-js@0.9.5/modules/$.own-keys");
  $def($def.S, 'Object', {getOwnPropertyDescriptors: function getOwnPropertyDescriptors(object) {
      var O = $.toObject(object),
          result = {};
      $.each.call(ownKeys(O), function(key) {
        $.setDesc(result, key, $.desc(0, $.getDesc(O, key)));
      });
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es7.object.to-array", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def");
  function createObjectToArray(isEntries) {
    return function(object) {
      var O = $.toObject(object),
          keys = $.getKeys(O),
          length = keys.length,
          i = 0,
          result = Array(length),
          key;
      if (isEntries)
        while (length > i)
          result[i] = [key = keys[i++], O[key]];
      else
        while (length > i)
          result[i] = O[keys[i++]];
      return result;
    };
  }
  $def($def.S, 'Object', {
    values: createObjectToArray(false),
    entries: createObjectToArray(true)
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.collection-to-json", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.for-of"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      forOf = require("npm:core-js@0.9.5/modules/$.for-of");
  module.exports = function(NAME) {
    $def($def.P, NAME, {toJSON: function toJSON() {
        var arr = [];
        forOf(this, false, arr.push, arr);
        return arr;
      }});
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es7.set.to-json", ["npm:core-js@0.9.5/modules/$.collection-to-json"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/modules/$.collection-to-json")('Set');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/js.array.statics", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      $Array = $.core.Array || Array,
      statics = {};
  function setStatics(keys, length) {
    $.each.call(keys.split(','), function(key) {
      if (length == undefined && key in $Array)
        statics[key] = $Array[key];
      else if (key in [])
        statics[key] = require("npm:core-js@0.9.5/modules/$.ctx")(Function.call, [][key], length);
    });
  }
  setStatics('pop,reverse,shift,keys,values,entries', 1);
  setStatics('indexOf,every,some,forEach,map,filter,find,findIndex,includes', 3);
  setStatics('join,slice,concat,push,splice,unshift,sort,lastIndexOf,' + 'reduce,reduceRight,copyWithin,fill,turn');
  $def($def.S, 'Array', statics);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.partial", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.invoke", "npm:core-js@0.9.5/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      invoke = require("npm:core-js@0.9.5/modules/$.invoke"),
      assertFunction = require("npm:core-js@0.9.5/modules/$.assert").fn;
  module.exports = function() {
    var fn = assertFunction(this),
        length = arguments.length,
        pargs = Array(length),
        i = 0,
        _ = $.path._,
        holder = false;
    while (length > i)
      if ((pargs[i] = arguments[i++]) === _)
        holder = true;
    return function() {
      var that = this,
          _length = arguments.length,
          j = 0,
          k = 0,
          args;
      if (!holder && !_length)
        return invoke(fn, pargs, that);
      args = pargs.slice();
      if (holder)
        for (; length > j; j++)
          if (args[j] === _)
            args[j] = arguments[k++];
      while (_length > k)
        args.push(arguments[k++]);
      return invoke(fn, args, that);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/web.immediate", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.task"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      $task = require("npm:core-js@0.9.5/modules/$.task");
  $def($def.G + $def.B, {
    setImmediate: $task.set,
    clearImmediate: $task.clear
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/web.dom.iterable", ["npm:core-js@0.9.5/modules/es6.array.iterator", "npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/modules/es6.array.iterator");
  var $ = require("npm:core-js@0.9.5/modules/$"),
      Iterators = require("npm:core-js@0.9.5/modules/$.iter").Iterators,
      ITERATOR = require("npm:core-js@0.9.5/modules/$.wks")('iterator'),
      ArrayValues = Iterators.Array,
      NodeList = $.g.NodeList;
  if ($.FW && NodeList && !(ITERATOR in NodeList.prototype)) {
    $.hide(NodeList.prototype, ITERATOR, ArrayValues);
  }
  Iterators.NodeList = ArrayValues;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.dict", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.ctx", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.assign", "npm:core-js@0.9.5/modules/$.keyof", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.for-of"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      ctx = require("npm:core-js@0.9.5/modules/$.ctx"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      assign = require("npm:core-js@0.9.5/modules/$.assign"),
      keyOf = require("npm:core-js@0.9.5/modules/$.keyof"),
      ITER = require("npm:core-js@0.9.5/modules/$.uid").safe('iter'),
      assert = require("npm:core-js@0.9.5/modules/$.assert"),
      $iter = require("npm:core-js@0.9.5/modules/$.iter"),
      forOf = require("npm:core-js@0.9.5/modules/$.for-of"),
      step = $iter.step,
      getKeys = $.getKeys,
      toObject = $.toObject,
      has = $.has;
  function Dict(iterable) {
    var dict = $.create(null);
    if (iterable != undefined) {
      if ($iter.is(iterable)) {
        forOf(iterable, true, function(key, value) {
          dict[key] = value;
        });
      } else
        assign(dict, iterable);
    }
    return dict;
  }
  Dict.prototype = null;
  function DictIterator(iterated, kind) {
    $.set(this, ITER, {
      o: toObject(iterated),
      a: getKeys(iterated),
      i: 0,
      k: kind
    });
  }
  $iter.create(DictIterator, 'Dict', function() {
    var iter = this[ITER],
        O = iter.o,
        keys = iter.a,
        kind = iter.k,
        key;
    do {
      if (iter.i >= keys.length) {
        iter.o = undefined;
        return step(1);
      }
    } while (!has(O, key = keys[iter.i++]));
    if (kind == 'keys')
      return step(0, key);
    if (kind == 'values')
      return step(0, O[key]);
    return step(0, [key, O[key]]);
  });
  function createDictIter(kind) {
    return function(it) {
      return new DictIterator(it, kind);
    };
  }
  function generic(A, B) {
    return typeof A == 'function' ? A : B;
  }
  function createDictMethod(TYPE) {
    var IS_MAP = TYPE == 1,
        IS_EVERY = TYPE == 4;
    return function(object, callbackfn, that) {
      var f = ctx(callbackfn, that, 3),
          O = toObject(object),
          result = IS_MAP || TYPE == 7 || TYPE == 2 ? new (generic(this, Dict)) : undefined,
          key,
          val,
          res;
      for (key in O)
        if (has(O, key)) {
          val = O[key];
          res = f(val, key, object);
          if (TYPE) {
            if (IS_MAP)
              result[key] = res;
            else if (res)
              switch (TYPE) {
                case 2:
                  result[key] = val;
                  break;
                case 3:
                  return true;
                case 5:
                  return val;
                case 6:
                  return key;
                case 7:
                  result[res[0]] = res[1];
              }
            else if (IS_EVERY)
              return false;
          }
        }
      return TYPE == 3 || IS_EVERY ? IS_EVERY : result;
    };
  }
  function createDictReduce(IS_TURN) {
    return function(object, mapfn, init) {
      assert.fn(mapfn);
      var O = toObject(object),
          keys = getKeys(O),
          length = keys.length,
          i = 0,
          memo,
          key,
          result;
      if (IS_TURN) {
        memo = init == undefined ? new (generic(this, Dict)) : Object(init);
      } else if (arguments.length < 3) {
        assert(length, 'Reduce of empty object with no initial value');
        memo = O[keys[i++]];
      } else
        memo = Object(init);
      while (length > i)
        if (has(O, key = keys[i++])) {
          result = mapfn(memo, O[key], key, object);
          if (IS_TURN) {
            if (result === false)
              break;
          } else
            memo = result;
        }
      return memo;
    };
  }
  var findKey = createDictMethod(6);
  $def($def.G + $def.F, {Dict: $.mix(Dict, {
      keys: createDictIter('keys'),
      values: createDictIter('values'),
      entries: createDictIter('entries'),
      forEach: createDictMethod(0),
      map: createDictMethod(1),
      filter: createDictMethod(2),
      some: createDictMethod(3),
      every: createDictMethod(4),
      find: createDictMethod(5),
      findKey: findKey,
      mapPairs: createDictMethod(7),
      reduce: createDictReduce(false),
      turn: createDictReduce(true),
      keyOf: keyOf,
      includes: function(object, el) {
        return (el == el ? keyOf(object, el) : findKey(object, function(it) {
          return it != it;
        })) !== undefined;
      },
      has: has,
      get: function(object, key) {
        if (has(object, key))
          return object[key];
      },
      set: $.def,
      isDict: function(it) {
        return $.isObject(it) && $.getProto(it) === Dict.prototype;
      }
    })});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.iter-helpers", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.iter"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var core = require("npm:core-js@0.9.5/modules/$").core,
      $iter = require("npm:core-js@0.9.5/modules/$.iter");
  core.isIterable = $iter.is;
  core.getIterator = $iter.get;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.$for", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.ctx", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.for-of", "npm:core-js@0.9.5/modules/$.iter-call"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      ctx = require("npm:core-js@0.9.5/modules/$.ctx"),
      safe = require("npm:core-js@0.9.5/modules/$.uid").safe,
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      $iter = require("npm:core-js@0.9.5/modules/$.iter"),
      forOf = require("npm:core-js@0.9.5/modules/$.for-of"),
      ENTRIES = safe('entries'),
      FN = safe('fn'),
      ITER = safe('iter'),
      call = require("npm:core-js@0.9.5/modules/$.iter-call"),
      getIterator = $iter.get,
      setIterator = $iter.set,
      createIterator = $iter.create;
  function $for(iterable, entries) {
    if (!(this instanceof $for))
      return new $for(iterable, entries);
    this[ITER] = getIterator(iterable);
    this[ENTRIES] = !!entries;
  }
  createIterator($for, 'Wrapper', function() {
    return this[ITER].next();
  });
  var $forProto = $for.prototype;
  setIterator($forProto, function() {
    return this[ITER];
  });
  function createChainIterator(next) {
    function Iterator(iter, fn, that) {
      this[ITER] = getIterator(iter);
      this[ENTRIES] = iter[ENTRIES];
      this[FN] = ctx(fn, that, iter[ENTRIES] ? 2 : 1);
    }
    createIterator(Iterator, 'Chain', next, $forProto);
    setIterator(Iterator.prototype, $.that);
    return Iterator;
  }
  var MapIter = createChainIterator(function() {
    var step = this[ITER].next();
    return step.done ? step : $iter.step(0, call(this[ITER], this[FN], step.value, this[ENTRIES]));
  });
  var FilterIter = createChainIterator(function() {
    for (; ; ) {
      var step = this[ITER].next();
      if (step.done || call(this[ITER], this[FN], step.value, this[ENTRIES]))
        return step;
    }
  });
  $.mix($forProto, {
    of: function(fn, that) {
      forOf(this, this[ENTRIES], fn, that);
    },
    array: function(fn, that) {
      var result = [];
      forOf(fn != undefined ? this.map(fn, that) : this, false, result.push, result);
      return result;
    },
    filter: function(fn, that) {
      return new FilterIter(this, fn, that);
    },
    map: function(fn, that) {
      return new MapIter(this, fn, that);
    }
  });
  $for.isIterable = $iter.is;
  $for.getIterator = getIterator;
  $def($def.G + $def.F, {$for: $for});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.delay", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.partial"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      partial = require("npm:core-js@0.9.5/modules/$.partial");
  $def($def.G + $def.F, {delay: function(time) {
      return new ($.core.Promise || $.g.Promise)(function(resolve) {
        setTimeout(partial.call(resolve, true), time);
      });
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.function.part", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.partial"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def");
  $.core._ = $.path._ = $.path._ || {};
  $def($def.P + $def.F, 'Function', {part: require("npm:core-js@0.9.5/modules/$.partial")});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.object", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.own-keys", "npm:core-js@0.9.5/modules/$.cof"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      ownKeys = require("npm:core-js@0.9.5/modules/$.own-keys");
  function define(target, mixin) {
    var keys = ownKeys($.toObject(mixin)),
        length = keys.length,
        i = 0,
        key;
    while (length > i)
      $.setDesc(target, key = keys[i++], $.getDesc(mixin, key));
    return target;
  }
  $def($def.S + $def.F, 'Object', {
    isObject: $.isObject,
    classof: require("npm:core-js@0.9.5/modules/$.cof").classof,
    define: define,
    make: function(proto, mixin) {
      return define($.create(proto), mixin);
    }
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.array.turn", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      assertFunction = require("npm:core-js@0.9.5/modules/$.assert").fn;
  $def($def.P + $def.F, 'Array', {turn: function(fn, target) {
      assertFunction(fn);
      var memo = target == undefined ? [] : Object(target),
          O = $.ES5Object(this),
          length = $.toLength(O.length),
          index = 0;
      while (length > index)
        if (fn(memo, O[index], index++, this) === false)
          break;
      return memo;
    }});
  require("npm:core-js@0.9.5/modules/$.unscope")('turn');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.number.iterator", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      ITER = require("npm:core-js@0.9.5/modules/$.uid").safe('iter');
  require("npm:core-js@0.9.5/modules/$.iter-define")(Number, 'Number', function(iterated) {
    $.set(this, ITER, {
      l: $.toLength(iterated),
      i: 0
    });
  }, function() {
    var iter = this[ITER],
        i = iter.i++,
        done = i >= iter.l;
    return {
      done: done,
      value: done ? undefined : i
    };
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.number.math", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.invoke"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      invoke = require("npm:core-js@0.9.5/modules/$.invoke"),
      methods = {};
  methods.random = function(lim) {
    var a = +this,
        b = lim == undefined ? 0 : +lim,
        m = Math.min(a, b);
    return Math.random() * (Math.max(a, b) - m) + m;
  };
  if ($.FW)
    $.each.call(('round,floor,ceil,abs,sin,asin,cos,acos,tan,atan,exp,sqrt,max,min,pow,atan2,' + 'acosh,asinh,atanh,cbrt,clz32,cosh,expm1,hypot,imul,log1p,log10,log2,sign,sinh,tanh,trunc').split(','), function(key) {
      var fn = Math[key];
      if (fn)
        methods[key] = function() {
          var args = [+this],
              i = 0;
          while (arguments.length > i)
            args.push(arguments[i++]);
          return invoke(fn, args);
        };
    });
  $def($def.P + $def.F, 'Number', methods);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.string.escape-html", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.replacer"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def"),
      replacer = require("npm:core-js@0.9.5/modules/$.replacer");
  var escapeHTMLDict = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  },
      unescapeHTMLDict = {},
      key;
  for (key in escapeHTMLDict)
    unescapeHTMLDict[escapeHTMLDict[key]] = key;
  $def($def.P + $def.F, 'String', {
    escapeHTML: replacer(/[&<>"']/g, escapeHTMLDict),
    unescapeHTML: replacer(/&(?:amp|lt|gt|quot|apos);/g, unescapeHTMLDict)
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.date", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      core = $.core,
      formatRegExp = /\b\w\w?\b/g,
      flexioRegExp = /:(.*)\|(.*)$/,
      locales = {},
      current = 'en',
      SECONDS = 'Seconds',
      MINUTES = 'Minutes',
      HOURS = 'Hours',
      DATE = 'Date',
      MONTH = 'Month',
      YEAR = 'FullYear';
  function lz(num) {
    return num > 9 ? num : '0' + num;
  }
  function createFormat(prefix) {
    return function(template, locale) {
      var that = this,
          dict = locales[$.has(locales, locale) ? locale : current];
      function get(unit) {
        return that[prefix + unit]();
      }
      return String(template).replace(formatRegExp, function(part) {
        switch (part) {
          case 's':
            return get(SECONDS);
          case 'ss':
            return lz(get(SECONDS));
          case 'm':
            return get(MINUTES);
          case 'mm':
            return lz(get(MINUTES));
          case 'h':
            return get(HOURS);
          case 'hh':
            return lz(get(HOURS));
          case 'D':
            return get(DATE);
          case 'DD':
            return lz(get(DATE));
          case 'W':
            return dict[0][get('Day')];
          case 'N':
            return get(MONTH) + 1;
          case 'NN':
            return lz(get(MONTH) + 1);
          case 'M':
            return dict[2][get(MONTH)];
          case 'MM':
            return dict[1][get(MONTH)];
          case 'Y':
            return get(YEAR);
          case 'YY':
            return lz(get(YEAR) % 100);
        }
        return part;
      });
    };
  }
  function addLocale(lang, locale) {
    function split(index) {
      var result = [];
      $.each.call(locale.months.split(','), function(it) {
        result.push(it.replace(flexioRegExp, '$' + index));
      });
      return result;
    }
    locales[lang] = [locale.weekdays.split(','), split(1), split(2)];
    return core;
  }
  $def($def.P + $def.F, DATE, {
    format: createFormat('get'),
    formatUTC: createFormat('getUTC')
  });
  addLocale(current, {
    weekdays: 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday',
    months: 'January,February,March,April,May,June,July,August,September,October,November,December'
  });
  addLocale('ru', {
    weekdays: 'Воскресенье,Понедельник,Вторник,Среда,Четверг,Пятница,Суббота',
    months: 'Январ:я|ь,Феврал:я|ь,Март:а|,Апрел:я|ь,Ма:я|й,Июн:я|ь,' + 'Июл:я|ь,Август:а|,Сентябр:я|ь,Октябр:я|ь,Ноябр:я|ь,Декабр:я|ь'
  });
  core.locale = function(locale) {
    return $.has(locales, locale) ? current = locale : current;
  };
  core.addLocale = addLocale;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.global", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.G + $def.F, {global: require("npm:core-js@0.9.5/modules/$").g});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/core.log", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      log = {},
      enabled = true;
  $.each.call(('assert,clear,count,debug,dir,dirxml,error,exception,' + 'group,groupCollapsed,groupEnd,info,isIndependentlyComposed,log,' + 'markTimeline,profile,profileEnd,table,time,timeEnd,timeline,' + 'timelineEnd,timeStamp,trace,warn').split(','), function(key) {
    log[key] = function() {
      if (enabled && $.g.console && $.isFunction(console[key])) {
        return Function.apply.call(console[key], console, arguments);
      }
    };
  });
  $def($def.G + $def.F, {log: require("npm:core-js@0.9.5/modules/$.assign")(log.log, log, {
      enable: function() {
        enabled = true;
      },
      disable: function() {
        enabled = false;
      }
    })});
  global.define = __define;
  return module.exports;
});

System.register("github:aurelia/metadata@0.5.0/reflect-metadata", ["npm:core-js@0.9.5"], function(_export) {
  var core,
      functionPrototype,
      _Map,
      _Set,
      _WeakMap,
      __Metadata__;
  function decorate(decorators, target, targetKey, targetDescriptor) {
    if (!IsUndefined(targetDescriptor)) {
      if (!IsArray(decorators)) {
        throw new TypeError();
      } else if (!IsObject(target)) {
        throw new TypeError();
      } else if (IsUndefined(targetKey)) {
        throw new TypeError();
      } else if (!IsObject(targetDescriptor)) {
        throw new TypeError();
      }
      targetKey = ToPropertyKey(targetKey);
      return DecoratePropertyWithDescriptor(decorators, target, targetKey, targetDescriptor);
    } else if (!IsUndefined(targetKey)) {
      if (!IsArray(decorators)) {
        throw new TypeError();
      } else if (!IsObject(target)) {
        throw new TypeError();
      }
      targetKey = ToPropertyKey(targetKey);
      return DecoratePropertyWithoutDescriptor(decorators, target, targetKey);
    } else {
      if (!IsArray(decorators)) {
        throw new TypeError();
      } else if (!IsConstructor(target)) {
        throw new TypeError();
      }
      return DecorateConstructor(decorators, target);
    }
  }
  function metadata(metadataKey, metadataValue) {
    function decorator(target, targetKey) {
      if (!IsUndefined(targetKey)) {
        if (!IsObject(target)) {
          throw new TypeError();
        }
        targetKey = ToPropertyKey(targetKey);
        OrdinaryDefineOwnMetadata(metadataKey, metadataValue, target, targetKey);
      } else {
        if (!IsConstructor(target)) {
          throw new TypeError();
        }
        OrdinaryDefineOwnMetadata(metadataKey, metadataValue, target, undefined);
      }
    }
    return decorator;
  }
  function defineMetadata(metadataKey, metadataValue, target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    return OrdinaryDefineOwnMetadata(metadataKey, metadataValue, target, targetKey);
  }
  function hasMetadata(metadataKey, target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    return OrdinaryHasMetadata(metadataKey, target, targetKey);
  }
  function hasOwnMetadata(metadataKey, target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    return OrdinaryHasOwnMetadata(metadataKey, target, targetKey);
  }
  function getMetadata(metadataKey, target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    return OrdinaryGetMetadata(metadataKey, target, targetKey);
  }
  function getOwnMetadata(metadataKey, target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    return OrdinaryGetOwnMetadata(metadataKey, target, targetKey);
  }
  function getMetadataKeys(target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    return OrdinaryMetadataKeys(target, targetKey);
  }
  function getOwnMetadataKeys(target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    return OrdinaryOwnMetadataKeys(target, targetKey);
  }
  function deleteMetadata(metadataKey, target, targetKey) {
    if (!IsObject(target)) {
      throw new TypeError();
    } else if (!IsUndefined(targetKey)) {
      targetKey = ToPropertyKey(targetKey);
    }
    var metadataMap = GetOrCreateMetadataMap(target, targetKey, false);
    if (IsUndefined(metadataMap)) {
      return false;
    }
    if (!metadataMap["delete"](metadataKey)) {
      return false;
    }
    if (metadataMap.size > 0) {
      return true;
    }
    var targetMetadata = __Metadata__.get(target);
    targetMetadata["delete"](targetKey);
    if (targetMetadata.size > 0) {
      return true;
    }
    __Metadata__["delete"](target);
    return true;
  }
  function DecorateConstructor(decorators, target) {
    for (var i = decorators.length - 1; i >= 0; --i) {
      var decorator = decorators[i];
      var decorated = decorator(target);
      if (!IsUndefined(decorated)) {
        if (!IsConstructor(decorated)) {
          throw new TypeError();
        }
        target = decorated;
      }
    }
    return target;
  }
  function DecoratePropertyWithDescriptor(decorators, target, propertyKey, descriptor) {
    for (var i = decorators.length - 1; i >= 0; --i) {
      var decorator = decorators[i];
      var decorated = decorator(target, propertyKey, descriptor);
      if (!IsUndefined(decorated)) {
        if (!IsObject(decorated)) {
          throw new TypeError();
        }
        descriptor = decorated;
      }
    }
    return descriptor;
  }
  function DecoratePropertyWithoutDescriptor(decorators, target, propertyKey) {
    for (var i = decorators.length - 1; i >= 0; --i) {
      var decorator = decorators[i];
      decorator(target, propertyKey);
    }
  }
  function GetOrCreateMetadataMap(target, targetKey, create) {
    var targetMetadata = __Metadata__.get(target);
    if (!targetMetadata) {
      if (!create) {
        return undefined;
      }
      targetMetadata = new _Map();
      __Metadata__.set(target, targetMetadata);
    }
    var keyMetadata = targetMetadata.get(targetKey);
    if (!keyMetadata) {
      if (!create) {
        return undefined;
      }
      keyMetadata = new _Map();
      targetMetadata.set(targetKey, keyMetadata);
    }
    return keyMetadata;
  }
  function OrdinaryHasMetadata(_x, _x2, _x3) {
    var _again = true;
    _function: while (_again) {
      hasOwn = parent = undefined;
      _again = false;
      var MetadataKey = _x,
          O = _x2,
          P = _x3;
      var hasOwn = OrdinaryHasOwnMetadata(MetadataKey, O, P);
      if (hasOwn) {
        return true;
      }
      var parent = GetPrototypeOf(O);
      if (parent !== null) {
        _x = MetadataKey;
        _x2 = parent;
        _x3 = P;
        _again = true;
        continue _function;
      }
      return false;
    }
  }
  function OrdinaryHasOwnMetadata(MetadataKey, O, P) {
    var metadataMap = GetOrCreateMetadataMap(O, P, false);
    if (metadataMap === undefined) {
      return false;
    }
    return Boolean(metadataMap.has(MetadataKey));
  }
  function OrdinaryGetMetadata(_x4, _x5, _x6) {
    var _again2 = true;
    _function2: while (_again2) {
      hasOwn = parent = undefined;
      _again2 = false;
      var MetadataKey = _x4,
          O = _x5,
          P = _x6;
      var hasOwn = OrdinaryHasOwnMetadata(MetadataKey, O, P);
      if (hasOwn) {
        return OrdinaryGetOwnMetadata(MetadataKey, O, P);
      }
      var parent = GetPrototypeOf(O);
      if (parent !== null) {
        _x4 = MetadataKey;
        _x5 = parent;
        _x6 = P;
        _again2 = true;
        continue _function2;
      }
      return undefined;
    }
  }
  function OrdinaryGetOwnMetadata(MetadataKey, O, P) {
    var metadataMap = GetOrCreateMetadataMap(O, P, false);
    if (metadataMap === undefined) {
      return undefined;
    }
    return metadataMap.get(MetadataKey);
  }
  function OrdinaryDefineOwnMetadata(MetadataKey, MetadataValue, O, P) {
    var metadataMap = GetOrCreateMetadataMap(O, P, true);
    metadataMap.set(MetadataKey, MetadataValue);
  }
  function OrdinaryMetadataKeys(O, P) {
    var ownKeys = OrdinaryOwnMetadataKeys(O, P);
    var parent = GetPrototypeOf(O);
    if (parent === null) {
      return ownKeys;
    }
    var parentKeys = OrdinaryMetadataKeys(parent, P);
    if (parentKeys.length <= 0) {
      return ownKeys;
    }
    if (ownKeys.length <= 0) {
      return parentKeys;
    }
    var set = new _Set();
    var keys = [];
    for (var _i = 0; _i < ownKeys.length; _i++) {
      var key = ownKeys[_i];
      var hasKey = set.has(key);
      if (!hasKey) {
        set.add(key);
        keys.push(key);
      }
    }
    for (var _a = 0; _a < parentKeys.length; _a++) {
      var key = parentKeys[_a];
      var hasKey = set.has(key);
      if (!hasKey) {
        set.add(key);
        keys.push(key);
      }
    }
    return keys;
  }
  function OrdinaryOwnMetadataKeys(target, targetKey) {
    var metadataMap = GetOrCreateMetadataMap(target, targetKey, false);
    var keys = [];
    if (metadataMap) {
      metadataMap.forEach(function(_, key) {
        return keys.push(key);
      });
    }
    return keys;
  }
  function IsUndefined(x) {
    return x === undefined;
  }
  function IsArray(x) {
    return Array.isArray(x);
  }
  function IsObject(x) {
    return typeof x === "object" ? x !== null : typeof x === "function";
  }
  function IsConstructor(x) {
    return typeof x === "function";
  }
  function IsSymbol(x) {
    return typeof x === "symbol";
  }
  function ToPropertyKey(value) {
    if (IsSymbol(value)) {
      return value;
    }
    return String(value);
  }
  function GetPrototypeOf(O) {
    var proto = Object.getPrototypeOf(O);
    if (typeof O !== "function" || O === functionPrototype) {
      return proto;
    }
    if (proto !== functionPrototype) {
      return proto;
    }
    var prototype = O.prototype;
    var prototypeProto = Object.getPrototypeOf(prototype);
    if (prototypeProto == null || prototypeProto === Object.prototype) {
      return proto;
    }
    var constructor = prototypeProto.constructor;
    if (typeof constructor !== "function") {
      return proto;
    }
    if (constructor === O) {
      return proto;
    }
    return constructor;
  }
  return {
    setters: [function(_coreJs) {
      core = _coreJs["default"];
    }],
    execute: function() {
      "use strict";
      functionPrototype = Object.getPrototypeOf(Function);
      _Map = Map;
      _Set = Set;
      _WeakMap = WeakMap;
      __Metadata__ = new _WeakMap();
      Reflect.decorate = decorate;
      Reflect.metadata = metadata;
      Reflect.defineMetadata = defineMetadata;
      Reflect.hasMetadata = hasMetadata;
      Reflect.hasOwnMetadata = hasOwnMetadata;
      Reflect.getMetadata = getMetadata;
      Reflect.getOwnMetadata = getOwnMetadata;
      Reflect.getMetadataKeys = getMetadataKeys;
      Reflect.getOwnMetadataKeys = getOwnMetadataKeys;
      Reflect.deleteMetadata = deleteMetadata;
    }
  };
});

System.register("github:aurelia/metadata@0.5.0/decorator-applicator", ["github:aurelia/metadata@0.5.0/metadata"], function(_export) {
  var Metadata,
      _classCallCheck,
      DecoratorApplicator;
  return {
    setters: [function(_metadata) {
      Metadata = _metadata.Metadata;
    }],
    execute: function() {
      'use strict';
      _classCallCheck = function(instance, Constructor) {
        if (!(instance instanceof Constructor)) {
          throw new TypeError('Cannot call a class as a function');
        }
      };
      DecoratorApplicator = (function() {
        function DecoratorApplicator() {
          _classCallCheck(this, DecoratorApplicator);
          this._first = null;
          this._second = null;
          this._third = null;
          this._rest = null;
        }
        DecoratorApplicator.prototype.decorator = (function(_decorator) {
          function decorator(_x) {
            return _decorator.apply(this, arguments);
          }
          decorator.toString = function() {
            return _decorator.toString();
          };
          return decorator;
        })(function(decorator) {
          if (this._first === null) {
            this._first = decorator;
            return this;
          }
          if (this._second === null) {
            this._second = decorator;
            return this;
          }
          if (this._third === null) {
            this._third = decorator;
            return this;
          }
          if (this._rest === null) {
            this._rest = [];
          }
          this._rest.push(decorator);
          return this;
        });
        DecoratorApplicator.prototype._decorate = function _decorate(target) {
          var i,
              ii,
              rest;
          if (this._first !== null) {
            this._first(target);
          }
          if (this._second !== null) {
            this._second(target);
          }
          if (this._third !== null) {
            this._third(target);
          }
          rest = this._rest;
          if (rest !== null) {
            for (i = 0, ii = rest.length; i < ii; ++i) {
              rest[i](target);
            }
          }
        };
        return DecoratorApplicator;
      })();
      _export('DecoratorApplicator', DecoratorApplicator);
    }
  };
});

System.register("npm:core-js@0.9.5/library/modules/$.fw", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = false;
    $.path = $.core;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/helpers/class-call-check", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/fn/object/create", ["npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$");
  module.exports = function create(P, D) {
    return $.create(P, D);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.def", ["npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      global = $.g,
      core = $.core,
      isFunction = $.isFunction;
  function ctx(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  }
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  function $def(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {}).prototype,
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      if (isGlobal && !isFunction(target[key]))
        exp = source[key];
      else if (type & $def.B && own)
        exp = ctx(out, global);
      else if (type & $def.W && target[key] == out)
        !function(C) {
          exp = function(param) {
            return this instanceof C ? new C(param) : C(param);
          };
          exp.prototype = C.prototype;
        }(out);
      else
        exp = type & $def.P && isFunction(out) ? ctx(Function.call, out) : out;
      $.hide(exports, key, exp);
    }
  }
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.assert", ["npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$");
  function assert(condition, msg1, msg2) {
    if (!condition)
      throw TypeError(msg2 ? msg1 + msg2 : msg1);
  }
  assert.def = $.assertDefined;
  assert.fn = function(it) {
    if (!$.isFunction(it))
      throw TypeError(it + ' is not a function!');
    return it;
  };
  assert.obj = function(it) {
    if (!$.isObject(it))
      throw TypeError(it + ' is not an object!');
    return it;
  };
  assert.inst = function(it, Constructor, name) {
    if (!(it instanceof Constructor))
      throw TypeError(name + ": use the 'new' operator!");
    return it;
  };
  module.exports = assert;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.ctx", ["npm:core-js@0.9.5/library/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertFunction = require("npm:core-js@0.9.5/library/modules/$.assert").fn;
  module.exports = function(fn, that, length) {
    assertFunction(fn);
    if (~length && that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.uid", ["npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var sid = 0;
  function uid(key) {
    return 'Symbol(' + key + ')_' + (++sid + Math.random()).toString(36);
  }
  uid.safe = require("npm:core-js@0.9.5/library/modules/$").g.Symbol || uid;
  module.exports = uid;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.own-keys", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      assertObject = require("npm:core-js@0.9.5/library/modules/$.assert").obj;
  module.exports = function ownKeys(it) {
    assertObject(it);
    var keys = $.getNames(it),
        getSymbols = $.getSymbols;
    return getSymbols ? keys.concat(getSymbols(it)) : keys;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/fn/object/freeze", ["npm:core-js@0.9.5/library/modules/es6.object.statics-accept-primitives", "npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/library/modules/es6.object.statics-accept-primitives");
  module.exports = require("npm:core-js@0.9.5/library/modules/$").core.Object.freeze;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/es6.object.to-string", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.cof", "npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      cof = require("npm:core-js@0.9.5/library/modules/$.cof"),
      tmp = {};
  tmp[require("npm:core-js@0.9.5/library/modules/$.wks")('toStringTag')] = 'z';
  if ($.FW && cof(tmp) != 'z')
    $.hide(Object.prototype, 'toString', function toString() {
      return '[object ' + cof.classof(this) + ']';
    });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.string-at", ["npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$");
  module.exports = function(TO_STRING) {
    return function(that, pos) {
      var s = String($.assertDefined(that)),
          i = $.toInteger(pos),
          l = s.length,
          a,
          b;
      if (i < 0 || i >= l)
        return TO_STRING ? '' : undefined;
      a = s.charCodeAt(i);
      return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.iter-define", ["npm:core-js@0.9.5/library/modules/$.def", "npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.cof", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/library/modules/$.def"),
      $ = require("npm:core-js@0.9.5/library/modules/$"),
      cof = require("npm:core-js@0.9.5/library/modules/$.cof"),
      $iter = require("npm:core-js@0.9.5/library/modules/$.iter"),
      SYMBOL_ITERATOR = require("npm:core-js@0.9.5/library/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      KEYS = 'keys',
      VALUES = 'values',
      Iterators = $iter.Iterators;
  module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
    $iter.create(Constructor, NAME, next);
    function createMethod(kind) {
      function $$(that) {
        return new Constructor(that, kind);
      }
      switch (kind) {
        case KEYS:
          return function keys() {
            return $$(this);
          };
        case VALUES:
          return function values() {
            return $$(this);
          };
      }
      return function entries() {
        return $$(this);
      };
    }
    var TAG = NAME + ' Iterator',
        proto = Base.prototype,
        _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
        _default = _native || createMethod(DEFAULT),
        methods,
        key;
    if (_native) {
      var IteratorPrototype = $.getProto(_default.call(new Base));
      cof.set(IteratorPrototype, TAG, true);
      if ($.FW && $.has(proto, FF_ITERATOR))
        $iter.set(IteratorPrototype, $.that);
    }
    if ($.FW)
      $iter.set(proto, _default);
    Iterators[NAME] = _default;
    Iterators[TAG] = $.that;
    if (DEFAULT) {
      methods = {
        keys: IS_SET ? _default : createMethod(KEYS),
        values: DEFAULT == VALUES ? _default : createMethod(VALUES),
        entries: DEFAULT != VALUES ? _default : createMethod('entries')
      };
      if (FORCE)
        for (key in methods) {
          if (!(key in proto))
            $.hide(proto, key, methods[key]);
        }
      else
        $def($def.P + $def.F * $iter.BUGGY, NAME, methods);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.unscope", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      UNSCOPABLES = require("npm:core-js@0.9.5/library/modules/$.wks")('unscopables');
  if ($.FW && !(UNSCOPABLES in []))
    $.hide(Array.prototype, UNSCOPABLES, {});
  module.exports = function(key) {
    if ($.FW)
      [][UNSCOPABLES][key] = true;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.iter-call", ["npm:core-js@0.9.5/library/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertObject = require("npm:core-js@0.9.5/library/modules/$.assert").obj;
  function close(iterator) {
    var ret = iterator['return'];
    if (ret !== undefined)
      assertObject(ret.call(iterator));
  }
  function call(iterator, fn, value, entries) {
    try {
      return entries ? fn(assertObject(value)[0], value[1]) : fn(value);
    } catch (e) {
      close(iterator);
      throw e;
    }
  }
  call.close = close;
  module.exports = call;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.species", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      SPECIES = require("npm:core-js@0.9.5/library/modules/$.wks")('species');
  module.exports = function(C) {
    if ($.DESC && !(SPECIES in C))
      $.setDesc(C, SPECIES, {
        configurable: true,
        get: $.that
      });
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.iter-detect", ["npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var SYMBOL_ITERATOR = require("npm:core-js@0.9.5/library/modules/$.wks")('iterator'),
      SAFE_CLOSING = false;
  try {
    var riter = [7][SYMBOL_ITERATOR]();
    riter['return'] = function() {
      SAFE_CLOSING = true;
    };
    Array.from(riter, function() {
      throw 2;
    });
  } catch (e) {}
  module.exports = function(exec) {
    if (!SAFE_CLOSING)
      return false;
    var safe = false;
    try {
      var arr = [7],
          iter = arr[SYMBOL_ITERATOR]();
      iter.next = function() {
        safe = true;
      };
      arr[SYMBOL_ITERATOR] = function() {
        return iter;
      };
      exec(arr);
    } catch (e) {}
    return safe;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.collection-to-json", ["npm:core-js@0.9.5/library/modules/$.def", "npm:core-js@0.9.5/library/modules/$.for-of"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/library/modules/$.def"),
      forOf = require("npm:core-js@0.9.5/library/modules/$.for-of");
  module.exports = function(NAME) {
    $def($def.P, NAME, {toJSON: function toJSON() {
        var arr = [];
        forOf(this, false, arr.push, arr);
        return arr;
      }});
  };
  global.define = __define;
  return module.exports;
});

System.register("github:aurelia/logging@0.4.0/index", [], function(_export) {
  var _classCallCheck,
      logLevel,
      loggers,
      currentLevel,
      appenders,
      slice,
      loggerConstructionKey,
      Logger;
  _export('AggregateError', AggregateError);
  _export('getLogger', getLogger);
  _export('addAppender', addAppender);
  _export('setLevel', setLevel);
  function AggregateError(msg, inner, skipIfAlreadyAggregate) {
    if (inner) {
      if (inner.innerError && skipIfAlreadyAggregate) {
        return inner;
      }
      if (inner.stack) {
        msg += '\n------------------------------------------------\ninner error: ' + inner.stack;
      }
    }
    var err = new Error(msg);
    if (inner) {
      err.innerError = inner;
    }
    return err;
  }
  function log(logger, level, args) {
    var i = appenders.length,
        current;
    args = slice.call(args);
    args.unshift(logger);
    while (i--) {
      current = appenders[i];
      current[level].apply(current, args);
    }
  }
  function debug() {
    if (currentLevel < 4) {
      return ;
    }
    log(this, 'debug', arguments);
  }
  function info() {
    if (currentLevel < 3) {
      return ;
    }
    log(this, 'info', arguments);
  }
  function warn() {
    if (currentLevel < 2) {
      return ;
    }
    log(this, 'warn', arguments);
  }
  function error() {
    if (currentLevel < 1) {
      return ;
    }
    log(this, 'error', arguments);
  }
  function connectLogger(logger) {
    logger.debug = debug;
    logger.info = info;
    logger.warn = warn;
    logger.error = error;
  }
  function createLogger(id) {
    var logger = new Logger(id, loggerConstructionKey);
    if (appenders.length) {
      connectLogger(logger);
    }
    return logger;
  }
  function getLogger(id) {
    return loggers[id] || (loggers[id] = createLogger(id));
  }
  function addAppender(appender) {
    appenders.push(appender);
    if (appenders.length === 1) {
      for (var key in loggers) {
        connectLogger(loggers[key]);
      }
    }
  }
  function setLevel(level) {
    currentLevel = level;
  }
  return {
    setters: [],
    execute: function() {
      'use strict';
      _classCallCheck = function(instance, Constructor) {
        if (!(instance instanceof Constructor)) {
          throw new TypeError('Cannot call a class as a function');
        }
      };
      logLevel = {
        none: 0,
        error: 1,
        warn: 2,
        info: 3,
        debug: 4
      };
      _export('logLevel', logLevel);
      loggers = {};
      currentLevel = logLevel.none;
      appenders = [];
      slice = Array.prototype.slice;
      loggerConstructionKey = {};
      Logger = (function() {
        function Logger(id, key) {
          _classCallCheck(this, Logger);
          if (key !== loggerConstructionKey) {
            throw new Error('You cannot instantiate "Logger". Use the "getLogger" API instead.');
          }
          this.id = id;
        }
        Logger.prototype.debug = function debug() {};
        Logger.prototype.info = function info() {};
        Logger.prototype.warn = function warn() {};
        Logger.prototype.error = function error() {};
        return Logger;
      })();
      _export('Logger', Logger);
    }
  };
});

System.register("npm:core-js@0.9.5/modules/$", ["npm:core-js@0.9.5/modules/$.fw"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.5/modules/$.fw")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    it: function(it) {
      return it;
    },
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    mix: function(target, src) {
      for (var key in src)
        hide(target, key, src[key]);
      return target;
    },
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.wks", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.uid"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var global = require("npm:core-js@0.9.5/modules/$").g,
      store = {};
  module.exports = function(name) {
    return store[name] || (store[name] = global.Symbol && global.Symbol[name] || require("npm:core-js@0.9.5/modules/$.uid").safe('Symbol.' + name));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.ctx", ["npm:core-js@0.9.5/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertFunction = require("npm:core-js@0.9.5/modules/$.assert").fn;
  module.exports = function(fn, that, length) {
    assertFunction(fn);
    if (~length && that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.symbol", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.keyof", "npm:core-js@0.9.5/modules/$.enum-keys", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      setTag = require("npm:core-js@0.9.5/modules/$.cof").set,
      uid = require("npm:core-js@0.9.5/modules/$.uid"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      keyOf = require("npm:core-js@0.9.5/modules/$.keyof"),
      enumKeys = require("npm:core-js@0.9.5/modules/$.enum-keys"),
      assertObject = require("npm:core-js@0.9.5/modules/$.assert").obj,
      has = $.has,
      $create = $.create,
      getDesc = $.getDesc,
      setDesc = $.setDesc,
      desc = $.desc,
      getNames = $.getNames,
      toObject = $.toObject,
      $Symbol = $.g.Symbol,
      setter = false,
      TAG = uid('tag'),
      HIDDEN = uid('hidden'),
      SymbolRegistry = {},
      AllSymbols = {},
      useNative = $.isFunction($Symbol);
  function wrap(tag) {
    var sym = AllSymbols[tag] = $.set($create($Symbol.prototype), TAG, tag);
    $.DESC && setter && setDesc(Object.prototype, tag, {
      configurable: true,
      set: function(value) {
        if (has(this, HIDDEN) && has(this[HIDDEN], tag))
          this[HIDDEN][tag] = false;
        setDesc(this, tag, desc(1, value));
      }
    });
    return sym;
  }
  function defineProperty(it, key, D) {
    if (D && has(AllSymbols, key)) {
      if (!D.enumerable) {
        if (!has(it, HIDDEN))
          setDesc(it, HIDDEN, desc(1, {}));
        it[HIDDEN][key] = true;
      } else {
        if (has(it, HIDDEN) && it[HIDDEN][key])
          it[HIDDEN][key] = false;
        D.enumerable = false;
      }
    }
    return setDesc(it, key, D);
  }
  function defineProperties(it, P) {
    assertObject(it);
    var keys = enumKeys(P = toObject(P)),
        i = 0,
        l = keys.length,
        key;
    while (l > i)
      defineProperty(it, key = keys[i++], P[key]);
    return it;
  }
  function create(it, P) {
    return P === undefined ? $create(it) : defineProperties($create(it), P);
  }
  function getOwnPropertyDescriptor(it, key) {
    var D = getDesc(it = toObject(it), key);
    if (D && has(AllSymbols, key) && !(has(it, HIDDEN) && it[HIDDEN][key]))
      D.enumerable = true;
    return D;
  }
  function getOwnPropertyNames(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (!has(AllSymbols, key = names[i++]) && key != HIDDEN)
        result.push(key);
    return result;
  }
  function getOwnPropertySymbols(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (has(AllSymbols, key = names[i++]))
        result.push(AllSymbols[key]);
    return result;
  }
  if (!useNative) {
    $Symbol = function Symbol(description) {
      if (this instanceof $Symbol)
        throw TypeError('Symbol is not a constructor');
      return wrap(uid(description));
    };
    $.hide($Symbol.prototype, 'toString', function() {
      return this[TAG];
    });
    $.create = create;
    $.setDesc = defineProperty;
    $.getDesc = getOwnPropertyDescriptor;
    $.setDescs = defineProperties;
    $.getNames = getOwnPropertyNames;
    $.getSymbols = getOwnPropertySymbols;
  }
  var symbolStatics = {
    'for': function(key) {
      return has(SymbolRegistry, key += '') ? SymbolRegistry[key] : SymbolRegistry[key] = $Symbol(key);
    },
    keyFor: function keyFor(key) {
      return keyOf(SymbolRegistry, key);
    },
    useSetter: function() {
      setter = true;
    },
    useSimple: function() {
      setter = false;
    }
  };
  $.each.call(('hasInstance,isConcatSpreadable,iterator,match,replace,search,' + 'species,split,toPrimitive,toStringTag,unscopables').split(','), function(it) {
    var sym = require("npm:core-js@0.9.5/modules/$.wks")(it);
    symbolStatics[it] = useNative ? sym : wrap(sym);
  });
  setter = true;
  $def($def.G + $def.W, {Symbol: $Symbol});
  $def($def.S, 'Symbol', symbolStatics);
  $def($def.S + $def.F * !useNative, 'Object', {
    create: create,
    defineProperty: defineProperty,
    defineProperties: defineProperties,
    getOwnPropertyDescriptor: getOwnPropertyDescriptor,
    getOwnPropertyNames: getOwnPropertyNames,
    getOwnPropertySymbols: getOwnPropertySymbols
  });
  setTag($Symbol, 'Symbol');
  setTag(Math, 'Math', true);
  setTag($.g.JSON, 'JSON', true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.object.assign", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.S, 'Object', {assign: require("npm:core-js@0.9.5/modules/$.assign")});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.object.set-prototype-of", ["npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.set-proto"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.5/modules/$.def");
  $def($def.S, 'Object', {setPrototypeOf: require("npm:core-js@0.9.5/modules/$.set-proto").set});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.string.iterator", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.string-at", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var set = require("npm:core-js@0.9.5/modules/$").set,
      $at = require("npm:core-js@0.9.5/modules/$.string-at")(true),
      ITER = require("npm:core-js@0.9.5/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.5/modules/$.iter"),
      step = $iter.step;
  require("npm:core-js@0.9.5/modules/$.iter-define")(String, 'String', function(iterated) {
    set(this, ITER, {
      o: String(iterated),
      i: 0
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        index = iter.i,
        point;
    if (index >= O.length)
      return step(1);
    point = $at(O, index);
    iter.i += point.length;
    return step(0, point);
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.from", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.ctx", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.iter-call", "npm:core-js@0.9.5/modules/$.iter-detect"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      ctx = require("npm:core-js@0.9.5/modules/$.ctx"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      $iter = require("npm:core-js@0.9.5/modules/$.iter"),
      call = require("npm:core-js@0.9.5/modules/$.iter-call");
  $def($def.S + $def.F * !require("npm:core-js@0.9.5/modules/$.iter-detect")(function(iter) {
    Array.from(iter);
  }), 'Array', {from: function from(arrayLike) {
      var O = Object($.assertDefined(arrayLike)),
          mapfn = arguments[1],
          mapping = mapfn !== undefined,
          f = mapping ? ctx(mapfn, arguments[2], 2) : undefined,
          index = 0,
          length,
          result,
          step,
          iterator;
      if ($iter.is(O)) {
        iterator = $iter.get(O);
        result = new (typeof this == 'function' ? this : Array);
        for (; !(step = iterator.next()).done; index++) {
          result[index] = mapping ? call(iterator, f, [step.value, index], true) : step.value;
        }
      } else {
        result = new (typeof this == 'function' ? this : Array)(length = $.toLength(O.length));
        for (; length > index; index++) {
          result[index] = mapping ? f(O[index], index) : O[index];
        }
      }
      result.length = index;
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.iterator", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.unscope", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      setUnscope = require("npm:core-js@0.9.5/modules/$.unscope"),
      ITER = require("npm:core-js@0.9.5/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.5/modules/$.iter"),
      step = $iter.step,
      Iterators = $iter.Iterators;
  require("npm:core-js@0.9.5/modules/$.iter-define")(Array, 'Array', function(iterated, kind) {
    $.set(this, ITER, {
      o: $.toObject(iterated),
      i: 0,
      k: kind
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        kind = iter.k,
        index = iter.i++;
    if (!O || index >= O.length) {
      iter.o = undefined;
      return step(1);
    }
    if (kind == 'keys')
      return step(0, index);
    if (kind == 'values')
      return step(0, O[index]);
    return step(0, [index, O[index]]);
  }, 'values');
  Iterators.Arguments = Iterators.Array;
  setUnscope('keys');
  setUnscope('values');
  setUnscope('entries');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.array.species", ["npm:core-js@0.9.5/modules/$.species"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/modules/$.species")(Array);
  global.define = __define;
  return module.exports;
});

System.register("npm:process@0.10.1", ["npm:process@0.10.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:process@0.10.1/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.map", ["npm:core-js@0.9.5/modules/$.collection-strong", "npm:core-js@0.9.5/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("npm:core-js@0.9.5/modules/$.collection-strong");
  require("npm:core-js@0.9.5/modules/$.collection")('Map', {
    get: function get(key) {
      var entry = strong.getEntry(this, key);
      return entry && entry.v;
    },
    set: function set(key, value) {
      return strong.def(this, key === 0 ? 0 : key, value);
    }
  }, strong, true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.weak-map", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.collection-weak", "npm:core-js@0.9.5/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/modules/$"),
      weak = require("npm:core-js@0.9.5/modules/$.collection-weak"),
      leakStore = weak.leakStore,
      ID = weak.ID,
      WEAK = weak.WEAK,
      has = $.has,
      isObject = $.isObject,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      tmp = {};
  var WeakMap = require("npm:core-js@0.9.5/modules/$.collection")('WeakMap', {
    get: function get(key) {
      if (isObject(key)) {
        if (isFrozen(key))
          return leakStore(this).get(key);
        if (has(key, WEAK))
          return key[WEAK][this[ID]];
      }
    },
    set: function set(key, value) {
      return weak.def(this, key, value);
    }
  }, weak, true, true);
  if ($.FW && new WeakMap().set((Object.freeze || Object)(tmp), 7).get(tmp) != 7) {
    $.each.call(['delete', 'has', 'get', 'set'], function(key) {
      var method = WeakMap.prototype[key];
      WeakMap.prototype[key] = function(a, b) {
        if (isObject(a) && isFrozen(a)) {
          var result = leakStore(this)[key](a, b);
          return key == 'set' ? this : result;
        }
        return method.call(this, a, b);
      };
    });
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.reflect", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.set-proto", "npm:core-js@0.9.5/modules/$.iter", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.own-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      setProto = require("npm:core-js@0.9.5/modules/$.set-proto"),
      $iter = require("npm:core-js@0.9.5/modules/$.iter"),
      ITER = require("npm:core-js@0.9.5/modules/$.uid").safe('iter'),
      step = $iter.step,
      assert = require("npm:core-js@0.9.5/modules/$.assert"),
      isObject = $.isObject,
      getProto = $.getProto,
      _apply = Function.apply,
      assertObject = assert.obj,
      _isExtensible = Object.isExtensible || $.isObject,
      _preventExtensions = Object.preventExtensions || $.it;
  function Enumerate(iterated) {
    $.set(this, ITER, {
      o: iterated,
      k: undefined,
      i: 0
    });
  }
  $iter.create(Enumerate, 'Object', function() {
    var iter = this[ITER],
        keys = iter.k,
        key;
    if (keys == undefined) {
      iter.k = keys = [];
      for (key in iter.o)
        keys.push(key);
    }
    do {
      if (iter.i >= keys.length)
        return step(1);
    } while (!((key = keys[iter.i++]) in iter.o));
    return step(0, key);
  });
  var reflect = {
    apply: function apply(target, thisArgument, argumentsList) {
      return _apply.call(target, thisArgument, argumentsList);
    },
    construct: function construct(target, argumentsList) {
      var proto = assert.fn(arguments.length < 3 ? target : arguments[2]).prototype,
          instance = $.create(isObject(proto) ? proto : Object.prototype),
          result = _apply.call(target, instance, argumentsList);
      return isObject(result) ? result : instance;
    },
    defineProperty: function defineProperty(target, propertyKey, attributes) {
      assertObject(target);
      try {
        $.setDesc(target, propertyKey, attributes);
        return true;
      } catch (e) {
        return false;
      }
    },
    deleteProperty: function deleteProperty(target, propertyKey) {
      var desc = $.getDesc(assertObject(target), propertyKey);
      return desc && !desc.configurable ? false : delete target[propertyKey];
    },
    enumerate: function enumerate(target) {
      return new Enumerate(assertObject(target));
    },
    get: function get(target, propertyKey) {
      var receiver = arguments.length < 3 ? target : arguments[2],
          desc = $.getDesc(assertObject(target), propertyKey),
          proto;
      if (desc)
        return $.has(desc, 'value') ? desc.value : desc.get === undefined ? undefined : desc.get.call(receiver);
      return isObject(proto = getProto(target)) ? get(proto, propertyKey, receiver) : undefined;
    },
    getOwnPropertyDescriptor: function getOwnPropertyDescriptor(target, propertyKey) {
      return $.getDesc(assertObject(target), propertyKey);
    },
    getPrototypeOf: function getPrototypeOf(target) {
      return getProto(assertObject(target));
    },
    has: function has(target, propertyKey) {
      return propertyKey in target;
    },
    isExtensible: function isExtensible(target) {
      return _isExtensible(assertObject(target));
    },
    ownKeys: require("npm:core-js@0.9.5/modules/$.own-keys"),
    preventExtensions: function preventExtensions(target) {
      assertObject(target);
      try {
        _preventExtensions(target);
        return true;
      } catch (e) {
        return false;
      }
    },
    set: function set(target, propertyKey, V) {
      var receiver = arguments.length < 4 ? target : arguments[3],
          ownDesc = $.getDesc(assertObject(target), propertyKey),
          existingDescriptor,
          proto;
      if (!ownDesc) {
        if (isObject(proto = getProto(target))) {
          return set(proto, propertyKey, V, receiver);
        }
        ownDesc = $.desc(0);
      }
      if ($.has(ownDesc, 'value')) {
        if (ownDesc.writable === false || !isObject(receiver))
          return false;
        existingDescriptor = $.getDesc(receiver, propertyKey) || $.desc(0);
        existingDescriptor.value = V;
        $.setDesc(receiver, propertyKey, existingDescriptor);
        return true;
      }
      return ownDesc.set === undefined ? false : (ownDesc.set.call(receiver, V), true);
    }
  };
  if (setProto)
    reflect.setPrototypeOf = function setPrototypeOf(target, proto) {
      setProto.check(target, proto);
      try {
        setProto.set(target, proto);
        return true;
      } catch (e) {
        return false;
      }
    };
  $def($def.G, {Reflect: {}});
  $def($def.S, 'Reflect', reflect);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es7.map.to-json", ["npm:core-js@0.9.5/modules/$.collection-to-json"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/modules/$.collection-to-json")('Map');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/web.timers", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.invoke", "npm:core-js@0.9.5/modules/$.partial"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      invoke = require("npm:core-js@0.9.5/modules/$.invoke"),
      partial = require("npm:core-js@0.9.5/modules/$.partial"),
      navigator = $.g.navigator,
      MSIE = !!navigator && /MSIE .\./.test(navigator.userAgent);
  function wrap(set) {
    return MSIE ? function(fn, time) {
      return set(invoke(partial, [].slice.call(arguments, 2), $.isFunction(fn) ? fn : Function(fn)), time);
    } : set;
  }
  $def($def.G + $def.B + $def.F * MSIE, {
    setTimeout: wrap($.g.setTimeout),
    setInterval: wrap($.g.setInterval)
  });
  global.define = __define;
  return module.exports;
});

System.register("github:aurelia/metadata@0.5.0/metadata", ["github:aurelia/metadata@0.5.0/reflect-metadata"], function(_export) {
  var meta,
      Metadata;
  function ensureDecorators(target) {
    var applicator;
    if (typeof target.decorators === 'function') {
      applicator = target.decorators();
    } else {
      applicator = target.decorators;
    }
    if (typeof applicator._decorate === 'function') {
      delete target.decorators;
      applicator._decorate(target);
    } else {
      throw new Error('The return value of your decorator\'s method was not valid.');
    }
  }
  return {
    setters: [function(_reflectMetadata) {
      meta = _reflectMetadata['default'];
    }],
    execute: function() {
      'use strict';
      Metadata = {
        resource: 'aurelia:resource',
        paramTypes: 'design:paramtypes',
        properties: 'design:properties',
        get: function get(metadataKey, target, propertyKey) {
          if (!target) {
            return undefined;
          }
          var result = Metadata.getOwn(metadataKey, target, propertyKey);
          return result === undefined ? Metadata.get(metadataKey, Object.getPrototypeOf(target), propertyKey) : result;
        },
        getOwn: function getOwn(metadataKey, target, propertyKey) {
          if (!target) {
            return undefined;
          }
          if (target.hasOwnProperty('decorators')) {
            ensureDecorators(target);
          }
          return Reflect.getOwnMetadata(metadataKey, target, propertyKey);
        },
        getOrCreateOwn: function getOrCreateOwn(metadataKey, Type, target, propertyKey) {
          var result = Metadata.getOwn(metadataKey, target, propertyKey);
          if (result === undefined) {
            result = new Type();
            Reflect.defineMetadata(metadataKey, result, target, propertyKey);
          }
          return result;
        }
      };
      _export('Metadata', Metadata);
    }
  };
});

System.register("github:aurelia/metadata@0.5.0/decorators", ["github:aurelia/metadata@0.5.0/decorator-applicator"], function(_export) {
  var DecoratorApplicator,
      Decorators;
  return {
    setters: [function(_decoratorApplicator) {
      DecoratorApplicator = _decoratorApplicator.DecoratorApplicator;
    }],
    execute: function() {
      'use strict';
      Decorators = {configure: {
          parameterizedDecorator: function parameterizedDecorator(name, decorator) {
            Decorators[name] = function() {
              var applicator = new DecoratorApplicator();
              return applicator[name].apply(applicator, arguments);
            };
            DecoratorApplicator.prototype[name] = function() {
              var result = decorator.apply(null, arguments);
              return this.decorator(result);
            };
          },
          simpleDecorator: function simpleDecorator(name, decorator) {
            Decorators[name] = function() {
              return new DecoratorApplicator().decorator(decorator);
            };
            DecoratorApplicator.prototype[name] = function() {
              return this.decorator(decorator);
            };
          }
        }};
      _export('Decorators', Decorators);
    }
  };
});

System.register("npm:core-js@0.9.5/library/modules/$", ["npm:core-js@0.9.5/library/modules/$.fw"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.5/library/modules/$.fw")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    it: function(it) {
      return it;
    },
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    mix: function(target, src) {
      for (var key in src)
        hide(target, key, src[key]);
      return target;
    },
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/core-js/object/create", ["npm:core-js@0.9.5/library/fn/object/create"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.5/library/fn/object/create"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/es6.object.statics-accept-primitives", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      $def = require("npm:core-js@0.9.5/library/modules/$.def"),
      isObject = $.isObject,
      toObject = $.toObject;
  function wrapObjectMethod(METHOD, MODE) {
    var fn = ($.core.Object || {})[METHOD] || Object[METHOD],
        f = 0,
        o = {};
    o[METHOD] = MODE == 1 ? function(it) {
      return isObject(it) ? fn(it) : it;
    } : MODE == 2 ? function(it) {
      return isObject(it) ? fn(it) : true;
    } : MODE == 3 ? function(it) {
      return isObject(it) ? fn(it) : false;
    } : MODE == 4 ? function getOwnPropertyDescriptor(it, key) {
      return fn(toObject(it), key);
    } : MODE == 5 ? function getPrototypeOf(it) {
      return fn(Object($.assertDefined(it)));
    } : function(it) {
      return fn(toObject(it));
    };
    try {
      fn('z');
    } catch (e) {
      f = 1;
    }
    $def($def.S + $def.F * f, 'Object', o);
  }
  wrapObjectMethod('freeze', 1);
  wrapObjectMethod('seal', 1);
  wrapObjectMethod('preventExtensions', 1);
  wrapObjectMethod('isFrozen', 2);
  wrapObjectMethod('isSealed', 2);
  wrapObjectMethod('isExtensible', 3);
  wrapObjectMethod('getOwnPropertyDescriptor', 4);
  wrapObjectMethod('getPrototypeOf', 5);
  wrapObjectMethod('keys');
  wrapObjectMethod('getOwnPropertyNames');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.set-proto", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.assert", "npm:core-js@0.9.5/library/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      assert = require("npm:core-js@0.9.5/library/modules/$.assert");
  function check(O, proto) {
    assert.obj(O);
    assert(proto === null || $.isObject(proto), proto, ": can't set as prototype!");
  }
  module.exports = {
    set: Object.setPrototypeOf || ('__proto__' in {} ? function(buggy, set) {
      try {
        set = require("npm:core-js@0.9.5/library/modules/$.ctx")(Function.call, $.getDesc(Object.prototype, '__proto__').set, 2);
        set({}, []);
      } catch (e) {
        buggy = true;
      }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy)
          O.__proto__ = proto;
        else
          set(O, proto);
        return O;
      };
    }() : undefined),
    check: check
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.wks", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.uid"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var global = require("npm:core-js@0.9.5/library/modules/$").g,
      store = {};
  module.exports = function(name) {
    return store[name] || (store[name] = global.Symbol && global.Symbol[name] || require("npm:core-js@0.9.5/library/modules/$.uid").safe('Symbol.' + name));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/core-js/object/freeze", ["npm:core-js@0.9.5/library/fn/object/freeze"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.5/library/fn/object/freeze"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/es6.string.iterator", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.string-at", "npm:core-js@0.9.5/library/modules/$.uid", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var set = require("npm:core-js@0.9.5/library/modules/$").set,
      $at = require("npm:core-js@0.9.5/library/modules/$.string-at")(true),
      ITER = require("npm:core-js@0.9.5/library/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.5/library/modules/$.iter"),
      step = $iter.step;
  require("npm:core-js@0.9.5/library/modules/$.iter-define")(String, 'String', function(iterated) {
    set(this, ITER, {
      o: String(iterated),
      i: 0
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        index = iter.i,
        point;
    if (index >= O.length)
      return step(1);
    point = $at(O, index);
    iter.i += point.length;
    return step(0, point);
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/es6.array.iterator", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.unscope", "npm:core-js@0.9.5/library/modules/$.uid", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      setUnscope = require("npm:core-js@0.9.5/library/modules/$.unscope"),
      ITER = require("npm:core-js@0.9.5/library/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.5/library/modules/$.iter"),
      step = $iter.step,
      Iterators = $iter.Iterators;
  require("npm:core-js@0.9.5/library/modules/$.iter-define")(Array, 'Array', function(iterated, kind) {
    $.set(this, ITER, {
      o: $.toObject(iterated),
      i: 0,
      k: kind
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        kind = iter.k,
        index = iter.i++;
    if (!O || index >= O.length) {
      iter.o = undefined;
      return step(1);
    }
    if (kind == 'keys')
      return step(0, index);
    if (kind == 'values')
      return step(0, O[index]);
    return step(0, [index, O[index]]);
  }, 'values');
  Iterators.Arguments = Iterators.Array;
  setUnscope('keys');
  setUnscope('values');
  setUnscope('entries');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.for-of", ["npm:core-js@0.9.5/library/modules/$.ctx", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.iter-call"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ctx = require("npm:core-js@0.9.5/library/modules/$.ctx"),
      get = require("npm:core-js@0.9.5/library/modules/$.iter").get,
      call = require("npm:core-js@0.9.5/library/modules/$.iter-call");
  module.exports = function(iterable, entries, fn, that) {
    var iterator = get(iterable),
        f = ctx(fn, that, entries ? 2 : 1),
        step;
    while (!(step = iterator.next()).done) {
      if (call(iterator, f, step.value, entries) === false) {
        return call.close(iterator);
      }
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.collection", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.def", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.for-of", "npm:core-js@0.9.5/library/modules/$.species", "npm:core-js@0.9.5/library/modules/$.assert", "npm:core-js@0.9.5/library/modules/$.iter-detect", "npm:core-js@0.9.5/library/modules/$.cof"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      $def = require("npm:core-js@0.9.5/library/modules/$.def"),
      BUGGY = require("npm:core-js@0.9.5/library/modules/$.iter").BUGGY,
      forOf = require("npm:core-js@0.9.5/library/modules/$.for-of"),
      species = require("npm:core-js@0.9.5/library/modules/$.species"),
      assertInstance = require("npm:core-js@0.9.5/library/modules/$.assert").inst;
  module.exports = function(NAME, methods, common, IS_MAP, IS_WEAK) {
    var Base = $.g[NAME],
        C = Base,
        ADDER = IS_MAP ? 'set' : 'add',
        proto = C && C.prototype,
        O = {};
    function fixMethod(KEY, CHAIN) {
      var method = proto[KEY];
      if ($.FW)
        proto[KEY] = function(a, b) {
          var result = method.call(this, a === 0 ? 0 : a, b);
          return CHAIN ? this : result;
        };
    }
    if (!$.isFunction(C) || !(IS_WEAK || !BUGGY && proto.forEach && proto.entries)) {
      C = common.getConstructor(NAME, IS_MAP, ADDER);
      $.mix(C.prototype, methods);
    } else {
      var inst = new C,
          chain = inst[ADDER](IS_WEAK ? {} : -0, 1),
          buggyZero;
      if (!require("npm:core-js@0.9.5/library/modules/$.iter-detect")(function(iter) {
        new C(iter);
      })) {
        C = function() {
          assertInstance(this, C, NAME);
          var that = new Base,
              iterable = arguments[0];
          if (iterable != undefined)
            forOf(iterable, IS_MAP, that[ADDER], that);
          return that;
        };
        C.prototype = proto;
        if ($.FW)
          proto.constructor = C;
      }
      IS_WEAK || inst.forEach(function(val, key) {
        buggyZero = 1 / key === -Infinity;
      });
      if (buggyZero) {
        fixMethod('delete');
        fixMethod('has');
        IS_MAP && fixMethod('get');
      }
      if (buggyZero || chain !== inst)
        fixMethod(ADDER, true);
    }
    require("npm:core-js@0.9.5/library/modules/$.cof").set(C, NAME);
    O[NAME] = C;
    $def($def.G + $def.W + $def.F * (C != Base), O);
    species(C);
    species($.core[NAME]);
    if (!IS_WEAK)
      common.setIter(C, NAME, IS_MAP);
    return C;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/es7.map.to-json", ["npm:core-js@0.9.5/library/modules/$.collection-to-json"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/library/modules/$.collection-to-json")('Map');
  global.define = __define;
  return module.exports;
});

System.register("github:aurelia/logging@0.4.0", ["github:aurelia/logging@0.4.0/index"], function($__export) {
  return {
    setters: [function(m) {
      for (var p in m)
        $__export(p, m[p]);
    }],
    execute: function() {}
  };
});

System.register("npm:core-js@0.9.5/modules/$.cof", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      TAG = require("npm:core-js@0.9.5/modules/$.wks")('toStringTag'),
      toString = {}.toString;
  function cof(it) {
    return toString.call(it).slice(8, -1);
  }
  cof.classof = function(it) {
    var O,
        T;
    return it == undefined ? it === undefined ? 'Undefined' : 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : cof(O);
  };
  cof.set = function(it, tag, stat) {
    if (it && !$.has(it = stat ? it : it.prototype, TAG))
      $.hide(it, TAG, tag);
  };
  module.exports = cof;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.array-methods", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      ctx = require("npm:core-js@0.9.5/modules/$.ctx");
  module.exports = function(TYPE) {
    var IS_MAP = TYPE == 1,
        IS_FILTER = TYPE == 2,
        IS_SOME = TYPE == 3,
        IS_EVERY = TYPE == 4,
        IS_FIND_INDEX = TYPE == 6,
        NO_HOLES = TYPE == 5 || IS_FIND_INDEX;
    return function($this, callbackfn, that) {
      var O = Object($.assertDefined($this)),
          self = $.ES5Object(O),
          f = ctx(callbackfn, that, 3),
          length = $.toLength(self.length),
          index = 0,
          result = IS_MAP ? Array(length) : IS_FILTER ? [] : undefined,
          val,
          res;
      for (; length > index; index++)
        if (NO_HOLES || index in self) {
          val = self[index];
          res = f(val, index, O);
          if (TYPE) {
            if (IS_MAP)
              result[index] = res;
            else if (res)
              switch (TYPE) {
                case 3:
                  return true;
                case 5:
                  return val;
                case 6:
                  return index;
                case 2:
                  result.push(val);
              }
            else if (IS_EVERY)
              return false;
          }
        }
      return IS_FIND_INDEX ? -1 : IS_SOME || IS_EVERY ? IS_EVERY : result;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-process@0.1.1/index", ["npm:process@0.10.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? process : require("npm:process@0.10.1");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/fn/object/define-property", ["npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/helpers/inherits", ["npm:babel-runtime@5.1.13/core-js/object/create"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$create = require("npm:babel-runtime@5.1.13/core-js/object/create")["default"];
  exports["default"] = function(subClass, superClass) {
    if (typeof superClass !== "function" && superClass !== null) {
      throw new TypeError("Super expression must either be null or a function, not " + typeof superClass);
    }
    subClass.prototype = _Object$create(superClass && superClass.prototype, {constructor: {
        value: subClass,
        enumerable: false,
        writable: true,
        configurable: true
      }});
    if (superClass)
      subClass.__proto__ = superClass;
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/fn/object/get-own-property-descriptor", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/es6.object.statics-accept-primitives"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$");
  require("npm:core-js@0.9.5/library/modules/es6.object.statics-accept-primitives");
  module.exports = function getOwnPropertyDescriptor(it, key) {
    return $.getDesc(it, key);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.cof", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      TAG = require("npm:core-js@0.9.5/library/modules/$.wks")('toStringTag'),
      toString = {}.toString;
  function cof(it) {
    return toString.call(it).slice(8, -1);
  }
  cof.classof = function(it) {
    var O,
        T;
    return it == undefined ? it === undefined ? 'Undefined' : 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : cof(O);
  };
  cof.set = function(it, tag, stat) {
    if (it && !$.has(it = stat ? it : it.prototype, TAG))
      $.hide(it, TAG, tag);
  };
  module.exports = cof;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/web.dom.iterable", ["npm:core-js@0.9.5/library/modules/es6.array.iterator", "npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/library/modules/es6.array.iterator");
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      Iterators = require("npm:core-js@0.9.5/library/modules/$.iter").Iterators,
      ITERATOR = require("npm:core-js@0.9.5/library/modules/$.wks")('iterator'),
      ArrayValues = Iterators.Array,
      NodeList = $.g.NodeList;
  if ($.FW && NodeList && !(ITERATOR in NodeList.prototype)) {
    $.hide(NodeList.prototype, ITERATOR, ArrayValues);
  }
  Iterators.NodeList = ArrayValues;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.collection-strong", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.ctx", "npm:core-js@0.9.5/library/modules/$.uid", "npm:core-js@0.9.5/library/modules/$.assert", "npm:core-js@0.9.5/library/modules/$.for-of", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      ctx = require("npm:core-js@0.9.5/library/modules/$.ctx"),
      safe = require("npm:core-js@0.9.5/library/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.5/library/modules/$.assert"),
      forOf = require("npm:core-js@0.9.5/library/modules/$.for-of"),
      step = require("npm:core-js@0.9.5/library/modules/$.iter").step,
      has = $.has,
      set = $.set,
      isObject = $.isObject,
      hide = $.hide,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      ID = safe('id'),
      O1 = safe('O1'),
      LAST = safe('last'),
      FIRST = safe('first'),
      ITER = safe('iter'),
      SIZE = $.DESC ? safe('size') : 'size',
      id = 0;
  function fastKey(it, create) {
    if (!isObject(it))
      return (typeof it == 'string' ? 'S' : 'P') + it;
    if (isFrozen(it))
      return 'F';
    if (!has(it, ID)) {
      if (!create)
        return 'E';
      hide(it, ID, ++id);
    }
    return 'O' + it[ID];
  }
  function getEntry(that, key) {
    var index = fastKey(key),
        entry;
    if (index != 'F')
      return that[O1][index];
    for (entry = that[FIRST]; entry; entry = entry.n) {
      if (entry.k == key)
        return entry;
    }
  }
  module.exports = {
    getConstructor: function(NAME, IS_MAP, ADDER) {
      function C() {
        var that = assert.inst(this, C, NAME),
            iterable = arguments[0];
        set(that, O1, $.create(null));
        set(that, SIZE, 0);
        set(that, LAST, undefined);
        set(that, FIRST, undefined);
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      }
      $.mix(C.prototype, {
        clear: function clear() {
          for (var that = this,
              data = that[O1],
              entry = that[FIRST]; entry; entry = entry.n) {
            entry.r = true;
            if (entry.p)
              entry.p = entry.p.n = undefined;
            delete data[entry.i];
          }
          that[FIRST] = that[LAST] = undefined;
          that[SIZE] = 0;
        },
        'delete': function(key) {
          var that = this,
              entry = getEntry(that, key);
          if (entry) {
            var next = entry.n,
                prev = entry.p;
            delete that[O1][entry.i];
            entry.r = true;
            if (prev)
              prev.n = next;
            if (next)
              next.p = prev;
            if (that[FIRST] == entry)
              that[FIRST] = next;
            if (that[LAST] == entry)
              that[LAST] = prev;
            that[SIZE]--;
          }
          return !!entry;
        },
        forEach: function forEach(callbackfn) {
          var f = ctx(callbackfn, arguments[1], 3),
              entry;
          while (entry = entry ? entry.n : this[FIRST]) {
            f(entry.v, entry.k, this);
            while (entry && entry.r)
              entry = entry.p;
          }
        },
        has: function has(key) {
          return !!getEntry(this, key);
        }
      });
      if ($.DESC)
        $.setDesc(C.prototype, 'size', {get: function() {
            return assert.def(this[SIZE]);
          }});
      return C;
    },
    def: function(that, key, value) {
      var entry = getEntry(that, key),
          prev,
          index;
      if (entry) {
        entry.v = value;
      } else {
        that[LAST] = entry = {
          i: index = fastKey(key, true),
          k: key,
          v: value,
          p: prev = that[LAST],
          n: undefined,
          r: false
        };
        if (!that[FIRST])
          that[FIRST] = entry;
        if (prev)
          prev.n = entry;
        that[SIZE]++;
        if (index != 'F')
          that[O1][index] = entry;
      }
      return that;
    },
    getEntry: getEntry,
    setIter: function(C, NAME, IS_MAP) {
      require("npm:core-js@0.9.5/library/modules/$.iter-define")(C, NAME, function(iterated, kind) {
        set(this, ITER, {
          o: iterated,
          k: kind
        });
      }, function() {
        var iter = this[ITER],
            kind = iter.k,
            entry = iter.l;
        while (entry && entry.r)
          entry = entry.p;
        if (!iter.o || !(iter.l = entry = entry ? entry.n : iter.o[FIRST])) {
          iter.o = undefined;
          return step(1);
        }
        if (kind == 'keys')
          return step(0, entry.k);
        if (kind == 'values')
          return step(0, entry.v);
        return step(0, [entry.k, entry.v]);
      }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es5", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.dom-create", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.invoke", "npm:core-js@0.9.5/modules/$.array-methods", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.array-includes", "npm:core-js@0.9.5/modules/$.replacer", "npm:core-js@0.9.5/modules/$.throws"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/modules/$"),
      cel = require("npm:core-js@0.9.5/modules/$.dom-create"),
      cof = require("npm:core-js@0.9.5/modules/$.cof"),
      $def = require("npm:core-js@0.9.5/modules/$.def"),
      invoke = require("npm:core-js@0.9.5/modules/$.invoke"),
      arrayMethod = require("npm:core-js@0.9.5/modules/$.array-methods"),
      IE_PROTO = require("npm:core-js@0.9.5/modules/$.uid").safe('__proto__'),
      assert = require("npm:core-js@0.9.5/modules/$.assert"),
      assertObject = assert.obj,
      ObjectProto = Object.prototype,
      A = [],
      slice = A.slice,
      indexOf = A.indexOf,
      classof = cof.classof,
      has = $.has,
      defineProperty = $.setDesc,
      getOwnDescriptor = $.getDesc,
      defineProperties = $.setDescs,
      isFunction = $.isFunction,
      toObject = $.toObject,
      toLength = $.toLength,
      IE8_DOM_DEFINE = false,
      $indexOf = require("npm:core-js@0.9.5/modules/$.array-includes")(false),
      $forEach = arrayMethod(0),
      $map = arrayMethod(1),
      $filter = arrayMethod(2),
      $some = arrayMethod(3),
      $every = arrayMethod(4);
  if (!$.DESC) {
    try {
      IE8_DOM_DEFINE = defineProperty(cel('div'), 'x', {get: function() {
          return 8;
        }}).x == 8;
    } catch (e) {}
    $.setDesc = function(O, P, Attributes) {
      if (IE8_DOM_DEFINE)
        try {
          return defineProperty(O, P, Attributes);
        } catch (e) {}
      if ('get' in Attributes || 'set' in Attributes)
        throw TypeError('Accessors not supported!');
      if ('value' in Attributes)
        assertObject(O)[P] = Attributes.value;
      return O;
    };
    $.getDesc = function(O, P) {
      if (IE8_DOM_DEFINE)
        try {
          return getOwnDescriptor(O, P);
        } catch (e) {}
      if (has(O, P))
        return $.desc(!ObjectProto.propertyIsEnumerable.call(O, P), O[P]);
    };
    $.setDescs = defineProperties = function(O, Properties) {
      assertObject(O);
      var keys = $.getKeys(Properties),
          length = keys.length,
          i = 0,
          P;
      while (length > i)
        $.setDesc(O, P = keys[i++], Properties[P]);
      return O;
    };
  }
  $def($def.S + $def.F * !$.DESC, 'Object', {
    getOwnPropertyDescriptor: $.getDesc,
    defineProperty: $.setDesc,
    defineProperties: defineProperties
  });
  var keys1 = ('constructor,hasOwnProperty,isPrototypeOf,propertyIsEnumerable,' + 'toLocaleString,toString,valueOf').split(','),
      keys2 = keys1.concat('length', 'prototype'),
      keysLen1 = keys1.length;
  var createDict = function() {
    var iframe = cel('iframe'),
        i = keysLen1,
        gt = '>',
        iframeDocument;
    iframe.style.display = 'none';
    $.html.appendChild(iframe);
    iframe.src = 'javascript:';
    iframeDocument = iframe.contentWindow.document;
    iframeDocument.open();
    iframeDocument.write('<script>document.F=Object</script' + gt);
    iframeDocument.close();
    createDict = iframeDocument.F;
    while (i--)
      delete createDict.prototype[keys1[i]];
    return createDict();
  };
  function createGetKeys(names, length) {
    return function(object) {
      var O = toObject(object),
          i = 0,
          result = [],
          key;
      for (key in O)
        if (key != IE_PROTO)
          has(O, key) && result.push(key);
      while (length > i)
        if (has(O, key = names[i++])) {
          ~indexOf.call(result, key) || result.push(key);
        }
      return result;
    };
  }
  function isPrimitive(it) {
    return !$.isObject(it);
  }
  function Empty() {}
  $def($def.S, 'Object', {
    getPrototypeOf: $.getProto = $.getProto || function(O) {
      O = Object(assert.def(O));
      if (has(O, IE_PROTO))
        return O[IE_PROTO];
      if (isFunction(O.constructor) && O instanceof O.constructor) {
        return O.constructor.prototype;
      }
      return O instanceof Object ? ObjectProto : null;
    },
    getOwnPropertyNames: $.getNames = $.getNames || createGetKeys(keys2, keys2.length, true),
    create: $.create = $.create || function(O, Properties) {
      var result;
      if (O !== null) {
        Empty.prototype = assertObject(O);
        result = new Empty();
        Empty.prototype = null;
        result[IE_PROTO] = O;
      } else
        result = createDict();
      return Properties === undefined ? result : defineProperties(result, Properties);
    },
    keys: $.getKeys = $.getKeys || createGetKeys(keys1, keysLen1, false),
    seal: $.it,
    freeze: $.it,
    preventExtensions: $.it,
    isSealed: isPrimitive,
    isFrozen: isPrimitive,
    isExtensible: $.isObject
  });
  $def($def.P, 'Function', {bind: function(that) {
      var fn = assert.fn(this),
          partArgs = slice.call(arguments, 1);
      function bound() {
        var args = partArgs.concat(slice.call(arguments));
        return invoke(fn, args, this instanceof bound ? $.create(fn.prototype) : that);
      }
      if (fn.prototype)
        bound.prototype = fn.prototype;
      return bound;
    }});
  function arrayMethodFix(fn) {
    return function() {
      return fn.apply($.ES5Object(this), arguments);
    };
  }
  if (!(0 in Object('z') && 'z'[0] == 'z')) {
    $.ES5Object = function(it) {
      return cof(it) == 'String' ? it.split('') : Object(it);
    };
  }
  $def($def.P + $def.F * ($.ES5Object != Object), 'Array', {
    slice: arrayMethodFix(slice),
    join: arrayMethodFix(A.join)
  });
  $def($def.S, 'Array', {isArray: function(arg) {
      return cof(arg) == 'Array';
    }});
  function createArrayReduce(isRight) {
    return function(callbackfn, memo) {
      assert.fn(callbackfn);
      var O = toObject(this),
          length = toLength(O.length),
          index = isRight ? length - 1 : 0,
          i = isRight ? -1 : 1;
      if (arguments.length < 2)
        for (; ; ) {
          if (index in O) {
            memo = O[index];
            index += i;
            break;
          }
          index += i;
          assert(isRight ? index >= 0 : length > index, 'Reduce of empty array with no initial value');
        }
      for (; isRight ? index >= 0 : length > index; index += i)
        if (index in O) {
          memo = callbackfn(memo, O[index], index, this);
        }
      return memo;
    };
  }
  $def($def.P, 'Array', {
    forEach: $.each = $.each || function forEach(callbackfn) {
      return $forEach(this, callbackfn, arguments[1]);
    },
    map: function map(callbackfn) {
      return $map(this, callbackfn, arguments[1]);
    },
    filter: function filter(callbackfn) {
      return $filter(this, callbackfn, arguments[1]);
    },
    some: function some(callbackfn) {
      return $some(this, callbackfn, arguments[1]);
    },
    every: function every(callbackfn) {
      return $every(this, callbackfn, arguments[1]);
    },
    reduce: createArrayReduce(false),
    reduceRight: createArrayReduce(true),
    indexOf: indexOf = indexOf || function indexOf(el) {
      return $indexOf(this, el, arguments[1]);
    },
    lastIndexOf: function(el, fromIndex) {
      var O = toObject(this),
          length = toLength(O.length),
          index = length - 1;
      if (arguments.length > 1)
        index = Math.min(index, $.toInteger(fromIndex));
      if (index < 0)
        index = toLength(length + index);
      for (; index >= 0; index--)
        if (index in O)
          if (O[index] === el)
            return index;
      return -1;
    }
  });
  $def($def.P, 'String', {trim: require("npm:core-js@0.9.5/modules/$.replacer")(/^\s*([\s\S]*\S)?\s*$/, '$1')});
  $def($def.S, 'Date', {now: function() {
      return +new Date;
    }});
  function lz(num) {
    return num > 9 ? num : '0' + num;
  }
  var date = new Date(-5e13 - 1),
      brokenDate = !(date.toISOString && date.toISOString() == '0385-07-25T07:06:39.999Z' && require("npm:core-js@0.9.5/modules/$.throws")(function() {
        new Date(NaN).toISOString();
      }));
  $def($def.P + $def.F * brokenDate, 'Date', {toISOString: function() {
      if (!isFinite(this))
        throw RangeError('Invalid time value');
      var d = this,
          y = d.getUTCFullYear(),
          m = d.getUTCMilliseconds(),
          s = y < 0 ? '-' : y > 9999 ? '+' : '';
      return s + ('00000' + Math.abs(y)).slice(s ? -6 : -4) + '-' + lz(d.getUTCMonth() + 1) + '-' + lz(d.getUTCDate()) + 'T' + lz(d.getUTCHours()) + ':' + lz(d.getUTCMinutes()) + ':' + lz(d.getUTCSeconds()) + '.' + (m > 99 ? m : '0' + lz(m)) + 'Z';
    }});
  if (classof(function() {
    return arguments;
  }()) == 'Object')
    cof.classof = function(it) {
      var tag = classof(it);
      return tag == 'Object' && isFunction(it.callee) ? 'Arguments' : tag;
    };
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-process@0.1.1", ["github:jspm/nodelibs-process@0.1.1/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-process@0.1.1/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/core-js/object/define-property", ["npm:core-js@0.9.5/library/fn/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.5/library/fn/object/define-property"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/core-js/object/get-own-property-descriptor", ["npm:core-js@0.9.5/library/fn/object/get-own-property-descriptor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.5/library/fn/object/get-own-property-descriptor"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/$.iter", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.cof", "npm:core-js@0.9.5/library/modules/$.assert", "npm:core-js@0.9.5/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      cof = require("npm:core-js@0.9.5/library/modules/$.cof"),
      assertObject = require("npm:core-js@0.9.5/library/modules/$.assert").obj,
      SYMBOL_ITERATOR = require("npm:core-js@0.9.5/library/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      Iterators = {},
      IteratorPrototype = {};
  setIterator(IteratorPrototype, $.that);
  function setIterator(O, value) {
    $.hide(O, SYMBOL_ITERATOR, value);
    if (FF_ITERATOR in [])
      $.hide(O, FF_ITERATOR, value);
  }
  module.exports = {
    BUGGY: 'keys' in [] && !('next' in [].keys()),
    Iterators: Iterators,
    step: function(done, value) {
      return {
        value: value,
        done: !!done
      };
    },
    is: function(it) {
      var O = Object(it),
          Symbol = $.g.Symbol,
          SYM = Symbol && Symbol.iterator || FF_ITERATOR;
      return SYM in O || SYMBOL_ITERATOR in O || $.has(Iterators, cof.classof(O));
    },
    get: function(it) {
      var Symbol = $.g.Symbol,
          ext = it[Symbol && Symbol.iterator || FF_ITERATOR],
          getIter = ext || it[SYMBOL_ITERATOR] || Iterators[cof.classof(it)];
      return assertObject(getIter.call(it));
    },
    set: setIterator,
    create: function(Constructor, NAME, next, proto) {
      Constructor.prototype = $.create(proto || IteratorPrototype, {next: $.desc(1, next)});
      cof.set(Constructor, NAME + ' Iterator');
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/es6.map", ["npm:core-js@0.9.5/library/modules/$.collection-strong", "npm:core-js@0.9.5/library/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("npm:core-js@0.9.5/library/modules/$.collection-strong");
  require("npm:core-js@0.9.5/library/modules/$.collection")('Map', {
    get: function get(key) {
      var entry = strong.getEntry(this, key);
      return entry && entry.v;
    },
    set: function set(key, value) {
      return strong.def(this, key === 0 ? 0 : key, value);
    }
  }, strong, true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/$.task", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.ctx", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.invoke", "npm:core-js@0.9.5/modules/$.dom-create", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.5/modules/$"),
        ctx = require("npm:core-js@0.9.5/modules/$.ctx"),
        cof = require("npm:core-js@0.9.5/modules/$.cof"),
        invoke = require("npm:core-js@0.9.5/modules/$.invoke"),
        cel = require("npm:core-js@0.9.5/modules/$.dom-create"),
        global = $.g,
        isFunction = $.isFunction,
        html = $.html,
        process = global.process,
        setTask = global.setImmediate,
        clearTask = global.clearImmediate,
        postMessage = global.postMessage,
        addEventListener = global.addEventListener,
        MessageChannel = global.MessageChannel,
        counter = 0,
        queue = {},
        ONREADYSTATECHANGE = 'onreadystatechange',
        defer,
        channel,
        port;
    function run() {
      var id = +this;
      if ($.has(queue, id)) {
        var fn = queue[id];
        delete queue[id];
        fn();
      }
    }
    function listner(event) {
      run.call(event.data);
    }
    if (!isFunction(setTask) || !isFunction(clearTask)) {
      setTask = function(fn) {
        var args = [],
            i = 1;
        while (arguments.length > i)
          args.push(arguments[i++]);
        queue[++counter] = function() {
          invoke(isFunction(fn) ? fn : Function(fn), args);
        };
        defer(counter);
        return counter;
      };
      clearTask = function(id) {
        delete queue[id];
      };
      if (cof(process) == 'process') {
        defer = function(id) {
          process.nextTick(ctx(run, id, 1));
        };
      } else if (addEventListener && isFunction(postMessage) && !global.importScripts) {
        defer = function(id) {
          postMessage(id, '*');
        };
        addEventListener('message', listner, false);
      } else if (isFunction(MessageChannel)) {
        channel = new MessageChannel;
        port = channel.port2;
        channel.port1.onmessage = listner;
        defer = ctx(port.postMessage, port, 1);
      } else if (ONREADYSTATECHANGE in cel('script')) {
        defer = function(id) {
          html.appendChild(cel('script'))[ONREADYSTATECHANGE] = function() {
            html.removeChild(this);
            run.call(id);
          };
        };
      } else {
        defer = function(id) {
          setTimeout(ctx(run, id, 1), 0);
        };
      }
    }
    module.exports = {
      set: setTask,
      clear: clearTask
    };
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/helpers/create-class", ["npm:babel-runtime@5.1.13/core-js/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.1.13/core-js/object/define-property")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/helpers/get", ["npm:babel-runtime@5.1.13/core-js/object/get-own-property-descriptor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$getOwnPropertyDescriptor = require("npm:babel-runtime@5.1.13/core-js/object/get-own-property-descriptor")["default"];
  exports["default"] = function get(_x, _x2, _x3) {
    var _again = true;
    _function: while (_again) {
      desc = parent = getter = undefined;
      _again = false;
      var object = _x,
          property = _x2,
          receiver = _x3;
      var desc = _Object$getOwnPropertyDescriptor(object, property);
      if (desc === undefined) {
        var parent = Object.getPrototypeOf(object);
        if (parent === null) {
          return undefined;
        } else {
          _x = parent;
          _x2 = property;
          _x3 = receiver;
          _again = true;
          continue _function;
        }
      } else if ("value" in desc) {
        return desc.value;
      } else {
        var getter = desc.get;
        if (getter === undefined) {
          return undefined;
        }
        return getter.call(receiver);
      }
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/modules/es6.reflect", ["npm:core-js@0.9.5/library/modules/$", "npm:core-js@0.9.5/library/modules/$.def", "npm:core-js@0.9.5/library/modules/$.set-proto", "npm:core-js@0.9.5/library/modules/$.iter", "npm:core-js@0.9.5/library/modules/$.uid", "npm:core-js@0.9.5/library/modules/$.assert", "npm:core-js@0.9.5/library/modules/$.own-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.5/library/modules/$"),
      $def = require("npm:core-js@0.9.5/library/modules/$.def"),
      setProto = require("npm:core-js@0.9.5/library/modules/$.set-proto"),
      $iter = require("npm:core-js@0.9.5/library/modules/$.iter"),
      ITER = require("npm:core-js@0.9.5/library/modules/$.uid").safe('iter'),
      step = $iter.step,
      assert = require("npm:core-js@0.9.5/library/modules/$.assert"),
      isObject = $.isObject,
      getProto = $.getProto,
      _apply = Function.apply,
      assertObject = assert.obj,
      _isExtensible = Object.isExtensible || $.isObject,
      _preventExtensions = Object.preventExtensions || $.it;
  function Enumerate(iterated) {
    $.set(this, ITER, {
      o: iterated,
      k: undefined,
      i: 0
    });
  }
  $iter.create(Enumerate, 'Object', function() {
    var iter = this[ITER],
        keys = iter.k,
        key;
    if (keys == undefined) {
      iter.k = keys = [];
      for (key in iter.o)
        keys.push(key);
    }
    do {
      if (iter.i >= keys.length)
        return step(1);
    } while (!((key = keys[iter.i++]) in iter.o));
    return step(0, key);
  });
  var reflect = {
    apply: function apply(target, thisArgument, argumentsList) {
      return _apply.call(target, thisArgument, argumentsList);
    },
    construct: function construct(target, argumentsList) {
      var proto = assert.fn(arguments.length < 3 ? target : arguments[2]).prototype,
          instance = $.create(isObject(proto) ? proto : Object.prototype),
          result = _apply.call(target, instance, argumentsList);
      return isObject(result) ? result : instance;
    },
    defineProperty: function defineProperty(target, propertyKey, attributes) {
      assertObject(target);
      try {
        $.setDesc(target, propertyKey, attributes);
        return true;
      } catch (e) {
        return false;
      }
    },
    deleteProperty: function deleteProperty(target, propertyKey) {
      var desc = $.getDesc(assertObject(target), propertyKey);
      return desc && !desc.configurable ? false : delete target[propertyKey];
    },
    enumerate: function enumerate(target) {
      return new Enumerate(assertObject(target));
    },
    get: function get(target, propertyKey) {
      var receiver = arguments.length < 3 ? target : arguments[2],
          desc = $.getDesc(assertObject(target), propertyKey),
          proto;
      if (desc)
        return $.has(desc, 'value') ? desc.value : desc.get === undefined ? undefined : desc.get.call(receiver);
      return isObject(proto = getProto(target)) ? get(proto, propertyKey, receiver) : undefined;
    },
    getOwnPropertyDescriptor: function getOwnPropertyDescriptor(target, propertyKey) {
      return $.getDesc(assertObject(target), propertyKey);
    },
    getPrototypeOf: function getPrototypeOf(target) {
      return getProto(assertObject(target));
    },
    has: function has(target, propertyKey) {
      return propertyKey in target;
    },
    isExtensible: function isExtensible(target) {
      return _isExtensible(assertObject(target));
    },
    ownKeys: require("npm:core-js@0.9.5/library/modules/$.own-keys"),
    preventExtensions: function preventExtensions(target) {
      assertObject(target);
      try {
        _preventExtensions(target);
        return true;
      } catch (e) {
        return false;
      }
    },
    set: function set(target, propertyKey, V) {
      var receiver = arguments.length < 4 ? target : arguments[3],
          ownDesc = $.getDesc(assertObject(target), propertyKey),
          existingDescriptor,
          proto;
      if (!ownDesc) {
        if (isObject(proto = getProto(target))) {
          return set(proto, propertyKey, V, receiver);
        }
        ownDesc = $.desc(0);
      }
      if ($.has(ownDesc, 'value')) {
        if (ownDesc.writable === false || !isObject(receiver))
          return false;
        existingDescriptor = $.getDesc(receiver, propertyKey) || $.desc(0);
        existingDescriptor.value = V;
        $.setDesc(receiver, propertyKey, existingDescriptor);
        return true;
      }
      return ownDesc.set === undefined ? false : (ownDesc.set.call(receiver, V), true);
    }
  };
  if (setProto)
    reflect.setPrototypeOf = function setPrototypeOf(target, proto) {
      setProto.check(target, proto);
      try {
        setProto.set(target, proto);
        return true;
      } catch (e) {
        return false;
      }
    };
  $def($def.G, {Reflect: {}});
  $def($def.S, 'Reflect', reflect);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/fn/map", ["npm:core-js@0.9.5/library/modules/es6.object.to-string", "npm:core-js@0.9.5/library/modules/es6.string.iterator", "npm:core-js@0.9.5/library/modules/web.dom.iterable", "npm:core-js@0.9.5/library/modules/es6.map", "npm:core-js@0.9.5/library/modules/es7.map.to-json", "npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/library/modules/es6.object.to-string");
  require("npm:core-js@0.9.5/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.5/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.5/library/modules/es6.map");
  require("npm:core-js@0.9.5/library/modules/es7.map.to-json");
  module.exports = require("npm:core-js@0.9.5/library/modules/$").core.Map;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/modules/es6.promise", ["npm:core-js@0.9.5/modules/$", "npm:core-js@0.9.5/modules/$.ctx", "npm:core-js@0.9.5/modules/$.cof", "npm:core-js@0.9.5/modules/$.def", "npm:core-js@0.9.5/modules/$.assert", "npm:core-js@0.9.5/modules/$.for-of", "npm:core-js@0.9.5/modules/$.set-proto", "npm:core-js@0.9.5/modules/$.species", "npm:core-js@0.9.5/modules/$.wks", "npm:core-js@0.9.5/modules/$.uid", "npm:core-js@0.9.5/modules/$.task", "npm:core-js@0.9.5/modules/$.iter-detect", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.5/modules/$"),
        ctx = require("npm:core-js@0.9.5/modules/$.ctx"),
        cof = require("npm:core-js@0.9.5/modules/$.cof"),
        $def = require("npm:core-js@0.9.5/modules/$.def"),
        assert = require("npm:core-js@0.9.5/modules/$.assert"),
        forOf = require("npm:core-js@0.9.5/modules/$.for-of"),
        setProto = require("npm:core-js@0.9.5/modules/$.set-proto").set,
        species = require("npm:core-js@0.9.5/modules/$.species"),
        SPECIES = require("npm:core-js@0.9.5/modules/$.wks")('species'),
        RECORD = require("npm:core-js@0.9.5/modules/$.uid").safe('record'),
        PROMISE = 'Promise',
        global = $.g,
        process = global.process,
        asap = process && process.nextTick || require("npm:core-js@0.9.5/modules/$.task").set,
        P = global[PROMISE],
        isFunction = $.isFunction,
        isObject = $.isObject,
        assertFunction = assert.fn,
        assertObject = assert.obj;
    var useNative = function() {
      var test,
          works = false;
      function P2(x) {
        var self = new P(x);
        setProto(self, P2.prototype);
        return self;
      }
      try {
        works = isFunction(P) && isFunction(P.resolve) && P.resolve(test = new P(function() {})) == test;
        setProto(P2, P);
        P2.prototype = $.create(P.prototype, {constructor: {value: P2}});
        if (!(P2.resolve(5).then(function() {}) instanceof P2)) {
          works = false;
        }
      } catch (e) {
        works = false;
      }
      return works;
    }();
    function getConstructor(C) {
      var S = assertObject(C)[SPECIES];
      return S != undefined ? S : C;
    }
    function isThenable(it) {
      var then;
      if (isObject(it))
        then = it.then;
      return isFunction(then) ? then : false;
    }
    function notify(record) {
      var chain = record.c;
      if (chain.length)
        asap(function() {
          var value = record.v,
              ok = record.s == 1,
              i = 0;
          function run(react) {
            var cb = ok ? react.ok : react.fail,
                ret,
                then;
            try {
              if (cb) {
                if (!ok)
                  record.h = true;
                ret = cb === true ? value : cb(value);
                if (ret === react.P) {
                  react.rej(TypeError('Promise-chain cycle'));
                } else if (then = isThenable(ret)) {
                  then.call(ret, react.res, react.rej);
                } else
                  react.res(ret);
              } else
                react.rej(value);
            } catch (err) {
              react.rej(err);
            }
          }
          while (chain.length > i)
            run(chain[i++]);
          chain.length = 0;
        });
    }
    function isUnhandled(promise) {
      var record = promise[RECORD],
          chain = record.a || record.c,
          i = 0,
          react;
      if (record.h)
        return false;
      while (chain.length > i) {
        react = chain[i++];
        if (react.fail || !isUnhandled(react.P))
          return false;
      }
      return true;
    }
    function $reject(value) {
      var record = this,
          promise;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      record.v = value;
      record.s = 2;
      record.a = record.c.slice();
      setTimeout(function() {
        asap(function() {
          if (isUnhandled(promise = record.p)) {
            if (cof(process) == 'process') {
              process.emit('unhandledRejection', value, promise);
            } else if (global.console && isFunction(console.error)) {
              console.error('Unhandled promise rejection', value);
            }
          }
          record.a = undefined;
        });
      }, 1);
      notify(record);
    }
    function $resolve(value) {
      var record = this,
          then,
          wrapper;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      try {
        if (then = isThenable(value)) {
          wrapper = {
            r: record,
            d: false
          };
          then.call(value, ctx($resolve, wrapper, 1), ctx($reject, wrapper, 1));
        } else {
          record.v = value;
          record.s = 1;
          notify(record);
        }
      } catch (err) {
        $reject.call(wrapper || {
          r: record,
          d: false
        }, err);
      }
    }
    if (!useNative) {
      P = function Promise(executor) {
        assertFunction(executor);
        var record = {
          p: assert.inst(this, P, PROMISE),
          c: [],
          a: undefined,
          s: 0,
          d: false,
          v: undefined,
          h: false
        };
        $.hide(this, RECORD, record);
        try {
          executor(ctx($resolve, record, 1), ctx($reject, record, 1));
        } catch (err) {
          $reject.call(record, err);
        }
      };
      $.mix(P.prototype, {
        then: function then(onFulfilled, onRejected) {
          var S = assertObject(assertObject(this).constructor)[SPECIES];
          var react = {
            ok: isFunction(onFulfilled) ? onFulfilled : true,
            fail: isFunction(onRejected) ? onRejected : false
          };
          var promise = react.P = new (S != undefined ? S : P)(function(res, rej) {
            react.res = assertFunction(res);
            react.rej = assertFunction(rej);
          });
          var record = this[RECORD];
          record.c.push(react);
          if (record.a)
            record.a.push(react);
          record.s && notify(record);
          return promise;
        },
        'catch': function(onRejected) {
          return this.then(undefined, onRejected);
        }
      });
    }
    $def($def.G + $def.W + $def.F * !useNative, {Promise: P});
    cof.set(P, PROMISE);
    species(P);
    species($.core[PROMISE]);
    $def($def.S + $def.F * !useNative, PROMISE, {
      reject: function reject(r) {
        return new (getConstructor(this))(function(res, rej) {
          rej(r);
        });
      },
      resolve: function resolve(x) {
        return isObject(x) && RECORD in x && $.getProto(x) === this.prototype ? x : new (getConstructor(this))(function(res) {
          res(x);
        });
      }
    });
    $def($def.S + $def.F * !(useNative && require("npm:core-js@0.9.5/modules/$.iter-detect")(function(iter) {
      P.all(iter)['catch'](function() {});
    })), PROMISE, {
      all: function all(iterable) {
        var C = getConstructor(this),
            values = [];
        return new C(function(res, rej) {
          forOf(iterable, false, values.push, values);
          var remaining = values.length,
              results = Array(remaining);
          if (remaining)
            $.each.call(values, function(promise, index) {
              C.resolve(promise).then(function(value) {
                results[index] = value;
                --remaining || res(results);
              }, rej);
            });
          else
            res(results);
        });
      },
      race: function race(iterable) {
        var C = getConstructor(this);
        return new C(function(res, rej) {
          forOf(iterable, false, function(promise) {
            C.resolve(promise).then(res, rej);
          });
        });
      }
    });
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/library/fn/reflect/construct", ["npm:core-js@0.9.5/library/modules/es6.reflect", "npm:core-js@0.9.5/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/library/modules/es6.reflect");
  module.exports = require("npm:core-js@0.9.5/library/modules/$").core.Reflect.construct;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/core-js/map", ["npm:core-js@0.9.5/library/fn/map"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.5/library/fn/map"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/shim", ["npm:core-js@0.9.5/modules/es5", "npm:core-js@0.9.5/modules/es6.symbol", "npm:core-js@0.9.5/modules/es6.object.assign", "npm:core-js@0.9.5/modules/es6.object.is", "npm:core-js@0.9.5/modules/es6.object.set-prototype-of", "npm:core-js@0.9.5/modules/es6.object.to-string", "npm:core-js@0.9.5/modules/es6.object.statics-accept-primitives", "npm:core-js@0.9.5/modules/es6.function.name", "npm:core-js@0.9.5/modules/es6.function.has-instance", "npm:core-js@0.9.5/modules/es6.number.constructor", "npm:core-js@0.9.5/modules/es6.number.statics", "npm:core-js@0.9.5/modules/es6.math", "npm:core-js@0.9.5/modules/es6.string.from-code-point", "npm:core-js@0.9.5/modules/es6.string.raw", "npm:core-js@0.9.5/modules/es6.string.iterator", "npm:core-js@0.9.5/modules/es6.string.code-point-at", "npm:core-js@0.9.5/modules/es6.string.ends-with", "npm:core-js@0.9.5/modules/es6.string.includes", "npm:core-js@0.9.5/modules/es6.string.repeat", "npm:core-js@0.9.5/modules/es6.string.starts-with", "npm:core-js@0.9.5/modules/es6.array.from", "npm:core-js@0.9.5/modules/es6.array.of", "npm:core-js@0.9.5/modules/es6.array.iterator", "npm:core-js@0.9.5/modules/es6.array.species", "npm:core-js@0.9.5/modules/es6.array.copy-within", "npm:core-js@0.9.5/modules/es6.array.fill", "npm:core-js@0.9.5/modules/es6.array.find", "npm:core-js@0.9.5/modules/es6.array.find-index", "npm:core-js@0.9.5/modules/es6.regexp", "npm:core-js@0.9.5/modules/es6.promise", "npm:core-js@0.9.5/modules/es6.map", "npm:core-js@0.9.5/modules/es6.set", "npm:core-js@0.9.5/modules/es6.weak-map", "npm:core-js@0.9.5/modules/es6.weak-set", "npm:core-js@0.9.5/modules/es6.reflect", "npm:core-js@0.9.5/modules/es7.array.includes", "npm:core-js@0.9.5/modules/es7.string.at", "npm:core-js@0.9.5/modules/es7.regexp.escape", "npm:core-js@0.9.5/modules/es7.object.get-own-property-descriptors", "npm:core-js@0.9.5/modules/es7.object.to-array", "npm:core-js@0.9.5/modules/es7.map.to-json", "npm:core-js@0.9.5/modules/es7.set.to-json", "npm:core-js@0.9.5/modules/js.array.statics", "npm:core-js@0.9.5/modules/web.timers", "npm:core-js@0.9.5/modules/web.immediate", "npm:core-js@0.9.5/modules/web.dom.iterable", "npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/modules/es5");
  require("npm:core-js@0.9.5/modules/es6.symbol");
  require("npm:core-js@0.9.5/modules/es6.object.assign");
  require("npm:core-js@0.9.5/modules/es6.object.is");
  require("npm:core-js@0.9.5/modules/es6.object.set-prototype-of");
  require("npm:core-js@0.9.5/modules/es6.object.to-string");
  require("npm:core-js@0.9.5/modules/es6.object.statics-accept-primitives");
  require("npm:core-js@0.9.5/modules/es6.function.name");
  require("npm:core-js@0.9.5/modules/es6.function.has-instance");
  require("npm:core-js@0.9.5/modules/es6.number.constructor");
  require("npm:core-js@0.9.5/modules/es6.number.statics");
  require("npm:core-js@0.9.5/modules/es6.math");
  require("npm:core-js@0.9.5/modules/es6.string.from-code-point");
  require("npm:core-js@0.9.5/modules/es6.string.raw");
  require("npm:core-js@0.9.5/modules/es6.string.iterator");
  require("npm:core-js@0.9.5/modules/es6.string.code-point-at");
  require("npm:core-js@0.9.5/modules/es6.string.ends-with");
  require("npm:core-js@0.9.5/modules/es6.string.includes");
  require("npm:core-js@0.9.5/modules/es6.string.repeat");
  require("npm:core-js@0.9.5/modules/es6.string.starts-with");
  require("npm:core-js@0.9.5/modules/es6.array.from");
  require("npm:core-js@0.9.5/modules/es6.array.of");
  require("npm:core-js@0.9.5/modules/es6.array.iterator");
  require("npm:core-js@0.9.5/modules/es6.array.species");
  require("npm:core-js@0.9.5/modules/es6.array.copy-within");
  require("npm:core-js@0.9.5/modules/es6.array.fill");
  require("npm:core-js@0.9.5/modules/es6.array.find");
  require("npm:core-js@0.9.5/modules/es6.array.find-index");
  require("npm:core-js@0.9.5/modules/es6.regexp");
  require("npm:core-js@0.9.5/modules/es6.promise");
  require("npm:core-js@0.9.5/modules/es6.map");
  require("npm:core-js@0.9.5/modules/es6.set");
  require("npm:core-js@0.9.5/modules/es6.weak-map");
  require("npm:core-js@0.9.5/modules/es6.weak-set");
  require("npm:core-js@0.9.5/modules/es6.reflect");
  require("npm:core-js@0.9.5/modules/es7.array.includes");
  require("npm:core-js@0.9.5/modules/es7.string.at");
  require("npm:core-js@0.9.5/modules/es7.regexp.escape");
  require("npm:core-js@0.9.5/modules/es7.object.get-own-property-descriptors");
  require("npm:core-js@0.9.5/modules/es7.object.to-array");
  require("npm:core-js@0.9.5/modules/es7.map.to-json");
  require("npm:core-js@0.9.5/modules/es7.set.to-json");
  require("npm:core-js@0.9.5/modules/js.array.statics");
  require("npm:core-js@0.9.5/modules/web.timers");
  require("npm:core-js@0.9.5/modules/web.immediate");
  require("npm:core-js@0.9.5/modules/web.dom.iterable");
  module.exports = require("npm:core-js@0.9.5/modules/$").core;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.1.13/core-js/reflect/construct", ["npm:core-js@0.9.5/library/fn/reflect/construct"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.5/library/fn/reflect/construct"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5/index", ["npm:core-js@0.9.5/shim", "npm:core-js@0.9.5/modules/core.dict", "npm:core-js@0.9.5/modules/core.iter-helpers", "npm:core-js@0.9.5/modules/core.$for", "npm:core-js@0.9.5/modules/core.delay", "npm:core-js@0.9.5/modules/core.function.part", "npm:core-js@0.9.5/modules/core.object", "npm:core-js@0.9.5/modules/core.array.turn", "npm:core-js@0.9.5/modules/core.number.iterator", "npm:core-js@0.9.5/modules/core.number.math", "npm:core-js@0.9.5/modules/core.string.escape-html", "npm:core-js@0.9.5/modules/core.date", "npm:core-js@0.9.5/modules/core.global", "npm:core-js@0.9.5/modules/core.log", "npm:core-js@0.9.5/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.5/shim");
  require("npm:core-js@0.9.5/modules/core.dict");
  require("npm:core-js@0.9.5/modules/core.iter-helpers");
  require("npm:core-js@0.9.5/modules/core.$for");
  require("npm:core-js@0.9.5/modules/core.delay");
  require("npm:core-js@0.9.5/modules/core.function.part");
  require("npm:core-js@0.9.5/modules/core.object");
  require("npm:core-js@0.9.5/modules/core.array.turn");
  require("npm:core-js@0.9.5/modules/core.number.iterator");
  require("npm:core-js@0.9.5/modules/core.number.math");
  require("npm:core-js@0.9.5/modules/core.string.escape-html");
  require("npm:core-js@0.9.5/modules/core.date");
  require("npm:core-js@0.9.5/modules/core.global");
  require("npm:core-js@0.9.5/modules/core.log");
  module.exports = require("npm:core-js@0.9.5/modules/$").core;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.5", ["npm:core-js@0.9.5/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:core-js@0.9.5/index");
  global.define = __define;
  return module.exports;
});

System.register("github:aurelia/metadata@0.5.0/origin", ["npm:core-js@0.9.5"], function(_export) {
  var core,
      _classCallCheck,
      originStorage,
      unknownOrigin,
      Origin;
  function ensureType(value) {
    if (value instanceof Origin) {
      return value;
    }
    return new Origin(value);
  }
  return {
    setters: [function(_coreJs) {
      core = _coreJs['default'];
    }],
    execute: function() {
      'use strict';
      _classCallCheck = function(instance, Constructor) {
        if (!(instance instanceof Constructor)) {
          throw new TypeError('Cannot call a class as a function');
        }
      };
      originStorage = new Map();
      unknownOrigin = Object.freeze({
        moduleId: undefined,
        moduleMember: undefined
      });
      Origin = (function() {
        function Origin(moduleId, moduleMember) {
          _classCallCheck(this, Origin);
          this.moduleId = moduleId;
          this.moduleMember = moduleMember;
        }
        Origin.get = function get(fn) {
          var origin = originStorage.get(fn);
          if (origin !== undefined) {
            return origin;
          }
          if (typeof fn.origin === 'function') {
            originStorage.set(fn, origin = ensureType(fn.origin()));
          } else if (fn.origin !== undefined) {
            originStorage.set(fn, origin = ensureType(fn.origin));
          }
          return origin || unknownOrigin;
        };
        Origin.set = function set(fn, origin) {
          if (Origin.get(fn) === unknownOrigin) {
            originStorage.set(fn, origin);
          }
        };
        return Origin;
      })();
      _export('Origin', Origin);
    }
  };
});

System.register("github:aurelia/metadata@0.5.0/index", ["github:aurelia/metadata@0.5.0/origin", "github:aurelia/metadata@0.5.0/metadata", "github:aurelia/metadata@0.5.0/decorators"], function(_export) {
  return {
    setters: [function(_origin) {
      _export('Origin', _origin.Origin);
    }, function(_metadata) {
      _export('Metadata', _metadata.Metadata);
    }, function(_decorators) {
      _export('Decorators', _decorators.Decorators);
    }],
    execute: function() {
      'use strict';
    }
  };
});

System.register("github:aurelia/metadata@0.5.0", ["github:aurelia/metadata@0.5.0/index"], function($__export) {
  return {
    setters: [function(m) {
      for (var p in m)
        $__export(p, m[p]);
    }],
    execute: function() {}
  };
});

System.register('src/container', ['npm:babel-runtime@5.1.13/helpers/create-class', 'npm:babel-runtime@5.1.13/helpers/class-call-check', 'npm:babel-runtime@5.1.13/core-js/object/define-property', 'npm:babel-runtime@5.1.13/core-js/object/freeze', 'npm:babel-runtime@5.1.13/core-js/map', 'npm:core-js@0.9.5', 'github:aurelia/metadata@0.5.0', 'github:aurelia/logging@0.4.0', 'src/metadata'], function (_export) {
  var _createClass, _classCallCheck, _Object$defineProperty, _Object$freeze, _Map, core, Metadata, AggregateError, Resolver, ClassActivator, emptyParameters, Container;

  // Fix Function#name on browsers that do not support it (IE):
  function test() {}
  return {
    setters: [function (_npmBabelRuntime5113HelpersCreateClass) {
      _createClass = _npmBabelRuntime5113HelpersCreateClass['default'];
    }, function (_npmBabelRuntime5113HelpersClassCallCheck) {
      _classCallCheck = _npmBabelRuntime5113HelpersClassCallCheck['default'];
    }, function (_npmBabelRuntime5113CoreJsObjectDefineProperty) {
      _Object$defineProperty = _npmBabelRuntime5113CoreJsObjectDefineProperty['default'];
    }, function (_npmBabelRuntime5113CoreJsObjectFreeze) {
      _Object$freeze = _npmBabelRuntime5113CoreJsObjectFreeze['default'];
    }, function (_npmBabelRuntime5113CoreJsMap) {
      _Map = _npmBabelRuntime5113CoreJsMap['default'];
    }, function (_npmCoreJs095) {
      core = _npmCoreJs095['default'];
    }, function (_githubAureliaMetadata050) {
      Metadata = _githubAureliaMetadata050.Metadata;
    }, function (_githubAureliaLogging040) {
      AggregateError = _githubAureliaLogging040.AggregateError;
    }, function (_srcMetadata) {
      Resolver = _srcMetadata.Resolver;
      ClassActivator = _srcMetadata.ClassActivator;
    }],
    execute: function () {
      'use strict';

      Metadata.registration = 'aurelia:registration';
      Metadata.instanceActivator = 'aurelia:instance-activator';if (!test.name) {
        _Object$defineProperty(Function.prototype, 'name', {
          get: function get() {
            var name = this.toString().match(/^\s*function\s*(\S*)\s*\(/)[1];
            // For better performance only parse once, and then cache the
            // result through a new accessor for repeated access.
            _Object$defineProperty(this, 'name', { value: name });
            return name;
          }
        });
      }

      emptyParameters = _Object$freeze([]);

      _export('emptyParameters', emptyParameters);

      /**
      * A lightweight, extensible dependency injection container.
      *
      * @class Container
      * @constructor
      */

      Container = (function () {
        function Container(constructionInfo) {
          _classCallCheck(this, Container);

          this.constructionInfo = constructionInfo || new _Map();
          this.entries = new _Map();
          this.root = this;
        }

        _createClass(Container, [{
          key: 'addParameterInfoLocator',

          /**
          * Adds an additional location to search for constructor parameter type info.
          *
          * @method addParameterInfoLocator
          * @param {Function} locator Configures a locator function to use when searching for parameter info. It should return undefined if no parameter info is found.
          */
          value: function addParameterInfoLocator(locator) {
            if (this.locateParameterInfoElsewhere === undefined) {
              this.locateParameterInfoElsewhere = locator;
              return;
            }

            var original = this.locateParameterInfoElsewhere;
            this.locateParameterInfoElsewhere = function (fn) {
              return original(fn) || locator(fn);
            };
          }
        }, {
          key: 'registerInstance',

          /**
          * Registers an existing object instance with the container.
          *
          * @method registerInstance
          * @param {Object} key The key that identifies the dependency at resolution time; usually a constructor function.
          * @param {Object} instance The instance that will be resolved when the key is matched.
          */
          value: function registerInstance(key, instance) {
            this.registerHandler(key, function (x) {
              return instance;
            });
          }
        }, {
          key: 'registerTransient',

          /**
          * Registers a type (constructor function) such that the container returns a new instance for each request.
          *
          * @method registerTransient
          * @param {Object} key The key that identifies the dependency at resolution time; usually a constructor function.
          * @param {Function} [fn] The constructor function to use when the dependency needs to be instantiated.
          */
          value: function registerTransient(key, fn) {
            fn = fn || key;
            this.registerHandler(key, function (x) {
              return x.invoke(fn);
            });
          }
        }, {
          key: 'registerSingleton',

          /**
          * Registers a type (constructor function) such that the container always returns the same instance for each request.
          *
          * @method registerSingleton
          * @param {Object} key The key that identifies the dependency at resolution time; usually a constructor function.
          * @param {Function} [fn] The constructor function to use when the dependency needs to be instantiated.
          */
          value: function registerSingleton(key, fn) {
            var singleton = null;
            fn = fn || key;
            this.registerHandler(key, function (x) {
              return singleton || (singleton = x.invoke(fn));
            });
          }
        }, {
          key: 'autoRegister',

          /**
          * Registers a type (constructor function) by inspecting its registration annotations. If none are found, then the default singleton registration is used.
          *
          * @method autoRegister
          * @param {Function} fn The constructor function to use when the dependency needs to be instantiated.
          * @param {Object} [key] The key that identifies the dependency at resolution time; usually a constructor function.
          */
          value: function autoRegister(fn, key) {
            var registration;

            if (fn === null || fn === undefined) {
              throw new Error('fn cannot be null or undefined.');
            }

            registration = Metadata.get(Metadata.registration, fn);

            if (registration !== undefined) {
              registration.register(this, key || fn, fn);
            } else {
              this.registerSingleton(key || fn, fn);
            }
          }
        }, {
          key: 'autoRegisterAll',

          /**
          * Registers an array of types (constructor functions) by inspecting their registration annotations. If none are found, then the default singleton registration is used.
          *
          * @method autoRegisterAll
          * @param {Function[]} fns The constructor function to use when the dependency needs to be instantiated.
          */
          value: function autoRegisterAll(fns) {
            var i = fns.length;
            while (i--) {
              this.autoRegister(fns[i]);
            }
          }
        }, {
          key: 'registerHandler',

          /**
          * Registers a custom resolution function such that the container calls this function for each request to obtain the instance.
          *
          * @method registerHandler
          * @param {Object} key The key that identifies the dependency at resolution time; usually a constructor function.
          * @param {Function} handler The resolution function to use when the dependency is needed. It will be passed one arguement, the container instance that is invoking it.
          */
          value: function registerHandler(key, handler) {
            this.getOrCreateEntry(key).push(handler);
          }
        }, {
          key: 'unregister',

          /**
          * Unregisters based on key.
          *
          * @method unregister
          * @param {Object} key The key that identifies the dependency at resolution time; usually a constructor function.
          */
          value: function unregister(key) {
            this.entries['delete'](key);
          }
        }, {
          key: 'get',

          /**
          * Resolves a single instance based on the provided key.
          *
          * @method get
          * @param {Object} key The key that identifies the object to resolve.
          * @return {Object} Returns the resolved instance.
          */
          value: function get(key) {
            var entry;

            if (key === null || key === undefined) {
              throw new Error('key cannot be null or undefined.');
            }

            if (key === Container) {
              return this;
            }

            if (key instanceof Resolver) {
              return key.get(this);
            }

            entry = this.entries.get(key);

            if (entry !== undefined) {
              return entry[0](this);
            }

            if (this.parent) {
              return this.parent.get(key);
            }

            this.autoRegister(key);
            entry = this.entries.get(key);

            return entry[0](this);
          }
        }, {
          key: 'getAll',

          /**
          * Resolves all instance registered under the provided key.
          *
          * @method getAll
          * @param {Object} key The key that identifies the objects to resolve.
          * @return {Object[]} Returns an array of the resolved instances.
          */
          value: function getAll(key) {
            var _this = this;

            var entry;

            if (key === null || key === undefined) {
              throw new Error('key cannot be null or undefined.');
            }

            entry = this.entries.get(key);

            if (entry !== undefined) {
              return entry.map(function (x) {
                return x(_this);
              });
            }

            if (this.parent) {
              return this.parent.getAll(key);
            }

            return [];
          }
        }, {
          key: 'hasHandler',

          /**
          * Inspects the container to determine if a particular key has been registred.
          *
          * @method hasHandler
          * @param {Object} key The key that identifies the dependency at resolution time; usually a constructor function.
          * @param {Boolean} [checkParent=false] Indicates whether or not to check the parent container hierarchy.
          * @return {Boolean} Returns true if the key has been registred; false otherwise.
          */
          value: function hasHandler(key) {
            var checkParent = arguments[1] === undefined ? false : arguments[1];

            if (key === null || key === undefined) {
              throw new Error('key cannot be null or undefined.');
            }

            return this.entries.has(key) || checkParent && this.parent && this.parent.hasHandler(key, checkParent);
          }
        }, {
          key: 'createChild',

          /**
          * Creates a new dependency injection container whose parent is the current container.
          *
          * @method createChild
          * @return {Container} Returns a new container instance parented to this.
          */
          value: function createChild() {
            var childContainer = new Container(this.constructionInfo);
            childContainer.parent = this;
            childContainer.root = this.root;
            childContainer.locateParameterInfoElsewhere = this.locateParameterInfoElsewhere;
            return childContainer;
          }
        }, {
          key: 'invoke',

          /**
          * Invokes a function, recursively resolving its dependencies.
          *
          * @method invoke
          * @param {Function} fn The function to invoke with the auto-resolved dependencies.
          * @return {Object} Returns the instance resulting from calling the function.
          */
          value: function invoke(fn) {
            try {
              var info = this.getOrCreateConstructionInfo(fn),
                  keys = info.keys,
                  args = new Array(keys.length),
                  i,
                  ii;

              for (i = 0, ii = keys.length; i < ii; ++i) {
                args[i] = this.get(keys[i]);
              }

              return info.activator.invoke(fn, args);
            } catch (e) {
              throw AggregateError('Error instantiating ' + fn.name + '.', e, true);
            }
          }
        }, {
          key: 'getOrCreateEntry',
          value: function getOrCreateEntry(key) {
            var entry;

            if (key === null || key === undefined) {
              throw new Error('key cannot be null or undefined.');
            }

            entry = this.entries.get(key);

            if (entry === undefined) {
              entry = [];
              this.entries.set(key, entry);
            }

            return entry;
          }
        }, {
          key: 'getOrCreateConstructionInfo',
          value: function getOrCreateConstructionInfo(fn) {
            var info = this.constructionInfo.get(fn);

            if (info === undefined) {
              info = this.createConstructionInfo(fn);
              this.constructionInfo.set(fn, info);
            }

            return info;
          }
        }, {
          key: 'createConstructionInfo',
          value: function createConstructionInfo(fn) {
            var info = { activator: Metadata.getOwn(Metadata.instanceActivator, fn) || ClassActivator.instance };

            if (fn.inject !== undefined) {
              if (typeof fn.inject === 'function') {
                info.keys = fn.inject();
              } else {
                info.keys = fn.inject;
              }

              return info;
            }

            if (this.locateParameterInfoElsewhere !== undefined) {
              info.keys = this.locateParameterInfoElsewhere(fn) || Reflect.getOwnMetadata(Metadata.paramTypes, fn) || emptyParameters;
            } else {
              info.keys = Reflect.getOwnMetadata(Metadata.paramTypes, fn) || emptyParameters;
            }

            return info;
          }
        }]);

        return Container;
      })();

      _export('Container', Container);
    }
  };
});
System.register('src/metadata', ['npm:babel-runtime@5.1.13/helpers/create-class', 'npm:babel-runtime@5.1.13/helpers/class-call-check', 'npm:babel-runtime@5.1.13/helpers/inherits', 'npm:babel-runtime@5.1.13/helpers/get', 'npm:babel-runtime@5.1.13/core-js/reflect/construct', 'npm:core-js@0.9.5'], function (_export) {
  var _createClass, _classCallCheck, _inherits, _get, _Reflect$construct, core, TransientRegistration, SingletonRegistration, Resolver, Lazy, All, Optional, Parent, ClassActivator, FactoryActivator;

  return {
    setters: [function (_npmBabelRuntime5113HelpersCreateClass) {
      _createClass = _npmBabelRuntime5113HelpersCreateClass['default'];
    }, function (_npmBabelRuntime5113HelpersClassCallCheck) {
      _classCallCheck = _npmBabelRuntime5113HelpersClassCallCheck['default'];
    }, function (_npmBabelRuntime5113HelpersInherits) {
      _inherits = _npmBabelRuntime5113HelpersInherits['default'];
    }, function (_npmBabelRuntime5113HelpersGet) {
      _get = _npmBabelRuntime5113HelpersGet['default'];
    }, function (_npmBabelRuntime5113CoreJsReflectConstruct) {
      _Reflect$construct = _npmBabelRuntime5113CoreJsReflectConstruct['default'];
    }, function (_npmCoreJs095) {
      core = _npmCoreJs095['default'];
    }],
    execute: function () {
      'use strict';

      /**
      * Used to allow functions/classes to indicate that they should be registered as transients with the container.
      *
      * @class TransientRegistration
      * @constructor
      * @param {Object} [key] The key to register as.
      */

      TransientRegistration = (function () {
        function TransientRegistration(key) {
          _classCallCheck(this, TransientRegistration);

          this.key = key;
        }

        _createClass(TransientRegistration, [{
          key: 'register',

          /**
          * Called by the container to register the annotated function/class as transient.
          *
          * @method register
          * @param {Container} container The container to register with.
          * @param {Object} key The key to register as.
          * @param {Object} fn The function to register (target of the annotation).
          */
          value: function register(container, key, fn) {
            container.registerTransient(this.key || key, fn);
          }
        }]);

        return TransientRegistration;
      })();

      _export('TransientRegistration', TransientRegistration);

      /**
      * Used to allow functions/classes to indicate that they should be registered as singletons with the container.
      *
      * @class SingletonRegistration
      * @constructor
      * @param {Object} [key] The key to register as.
      */

      SingletonRegistration = (function () {
        function SingletonRegistration(keyOrRegisterInChild) {
          var registerInChild = arguments[1] === undefined ? false : arguments[1];

          _classCallCheck(this, SingletonRegistration);

          if (typeof keyOrRegisterInChild === 'boolean') {
            this.registerInChild = keyOrRegisterInChild;
          } else {
            this.key = keyOrRegisterInChild;
            this.registerInChild = registerInChild;
          }
        }

        _createClass(SingletonRegistration, [{
          key: 'register',

          /**
          * Called by the container to register the annotated function/class as a singleton.
          *
          * @method register
          * @param {Container} container The container to register with.
          * @param {Object} key The key to register as.
          * @param {Object} fn The function to register (target of the annotation).
          */
          value: function register(container, key, fn) {
            var destination = this.registerInChild ? container : container.root;
            destination.registerSingleton(this.key || key, fn);
          }
        }]);

        return SingletonRegistration;
      })();

      _export('SingletonRegistration', SingletonRegistration);

      /**
      * An abstract resolver used to allow functions/classes to specify custom dependency resolution logic.
      *
      * @class Resolver
      * @constructor
      */

      Resolver = (function () {
        function Resolver() {
          _classCallCheck(this, Resolver);
        }

        _createClass(Resolver, [{
          key: 'get',

          /**
          * Called by the container to allow custom resolution of dependencies for a function/class.
          *
          * @method get
          * @param {Container} container The container to resolve from.
          * @return {Object} Returns the resolved object.
          */
          value: function get(container) {
            throw new Error('A custom Resolver must implement get(container) and return the resolved instance(s).');
          }
        }]);

        return Resolver;
      })();

      _export('Resolver', Resolver);

      /**
      * Used to allow functions/classes to specify lazy resolution logic.
      *
      * @class Lazy
      * @constructor
      * @extends Resolver
      * @param {Object} key The key to lazily resolve.
      */

      Lazy = (function (_Resolver) {
        function Lazy(key) {
          _classCallCheck(this, Lazy);

          _get(Object.getPrototypeOf(Lazy.prototype), 'constructor', this).call(this);
          this.key = key;
        }

        _inherits(Lazy, _Resolver);

        _createClass(Lazy, [{
          key: 'get',

          /**
          * Called by the container to lazily resolve the dependency into a lazy locator function.
          *
          * @method get
          * @param {Container} container The container to resolve from.
          * @return {Function} Returns a function which can be invoked at a later time to obtain the actual dependency.
          */
          value: function get(container) {
            var _this = this;

            return function () {
              return container.get(_this.key);
            };
          }
        }], [{
          key: 'of',

          /**
          * Creates a Lazy Resolver for the supplied key.
          *
          * @method of
          * @static
          * @param {Object} key The key to lazily resolve.
          * @return {Lazy} Returns an insance of Lazy for the key.
          */
          value: function of(key) {
            return new Lazy(key);
          }
        }]);

        return Lazy;
      })(Resolver);

      _export('Lazy', Lazy);

      /**
      * Used to allow functions/classes to specify resolution of all matches to a key.
      *
      * @class All
      * @constructor
      * @extends Resolver
      * @param {Object} key The key to lazily resolve all matches for.
      */

      All = (function (_Resolver2) {
        function All(key) {
          _classCallCheck(this, All);

          _get(Object.getPrototypeOf(All.prototype), 'constructor', this).call(this);
          this.key = key;
        }

        _inherits(All, _Resolver2);

        _createClass(All, [{
          key: 'get',

          /**
          * Called by the container to resolve all matching dependencies as an array of instances.
          *
          * @method get
          * @param {Container} container The container to resolve from.
          * @return {Object[]} Returns an array of all matching instances.
          */
          value: function get(container) {
            return container.getAll(this.key);
          }
        }], [{
          key: 'of',

          /**
          * Creates an All Resolver for the supplied key.
          *
          * @method of
          * @static
          * @param {Object} key The key to resolve all instances for.
          * @return {All} Returns an insance of All for the key.
          */
          value: function of(key) {
            return new All(key);
          }
        }]);

        return All;
      })(Resolver);

      _export('All', All);

      /**
      * Used to allow functions/classes to specify an optional dependency, which will be resolved only if already registred with the container.
      *
      * @class Optional
      * @constructor
      * @extends Resolver
      * @param {Object} key The key to optionally resolve for.
      * @param {Boolean} [checkParent=false] Indicates whether or not the parent container hierarchy should be checked.
      */

      Optional = (function (_Resolver3) {
        function Optional(key) {
          var checkParent = arguments[1] === undefined ? false : arguments[1];

          _classCallCheck(this, Optional);

          _get(Object.getPrototypeOf(Optional.prototype), 'constructor', this).call(this);
          this.key = key;
          this.checkParent = checkParent;
        }

        _inherits(Optional, _Resolver3);

        _createClass(Optional, [{
          key: 'get',

          /**
          * Called by the container to provide optional resolution of the key.
          *
          * @method get
          * @param {Container} container The container to resolve from.
          * @return {Object} Returns the instance if found; otherwise null.
          */
          value: function get(container) {
            if (container.hasHandler(this.key, this.checkParent)) {
              return container.get(this.key);
            }

            return null;
          }
        }], [{
          key: 'of',

          /**
          * Creates an Optional Resolver for the supplied key.
          *
          * @method of
          * @static
          * @param {Object} key The key to optionally resolve for.
          * @param {Boolean} [checkParent=false] Indicates whether or not the parent container hierarchy should be checked.
          * @return {Optional} Returns an insance of Optional for the key.
          */
          value: function of(key) {
            var checkParent = arguments[1] === undefined ? false : arguments[1];

            return new Optional(key, checkParent);
          }
        }]);

        return Optional;
      })(Resolver);

      _export('Optional', Optional);

      /**
      * Used to inject the dependency from the parent container instead of the current one.
      *
      * @class Parent
      * @constructor
      * @extends Resolver
      * @param {Object} key The key to resolve from the parent container.
      */

      Parent = (function (_Resolver4) {
        function Parent(key) {
          _classCallCheck(this, Parent);

          _get(Object.getPrototypeOf(Parent.prototype), 'constructor', this).call(this);
          this.key = key;
        }

        _inherits(Parent, _Resolver4);

        _createClass(Parent, [{
          key: 'get',

          /**
          * Called by the container to load the dependency from the parent container
          *
          * @method get
          * @param {Container} container The container to resolve the parent from.
          * @return {Function} Returns the matching instance from the parent container
          */
          value: function get(container) {
            return container.parent ? container.parent.get(this.key) : null;
          }
        }], [{
          key: 'of',

          /**
          * Creates a Parent Resolver for the supplied key.
          *
          * @method of
          * @static
          * @param {Object} key The key to resolve.
          * @return {Parent} Returns an insance of Parent for the key.
          */
          value: function of(key) {
            return new Parent(key);
          }
        }]);

        return Parent;
      })(Resolver);

      _export('Parent', Parent);

      /**
      * Used to instantiate a class.
      *
      * @class ClassActivator
      * @constructor
      */

      ClassActivator = (function () {
        function ClassActivator() {
          _classCallCheck(this, ClassActivator);
        }

        _createClass(ClassActivator, [{
          key: 'invoke',
          value: function invoke(fn, args) {
            return _Reflect$construct(fn, args);
          }
        }], [{
          key: 'instance',
          value: new ClassActivator(),
          enumerable: true
        }]);

        return ClassActivator;
      })();

      _export('ClassActivator', ClassActivator);

      /**
      * Used to invoke a factory method.
      *
      * @class FactoryActivator
      * @constructor
      */

      FactoryActivator = (function () {
        function FactoryActivator() {
          _classCallCheck(this, FactoryActivator);
        }

        _createClass(FactoryActivator, [{
          key: 'invoke',
          value: function invoke(fn, args) {
            return fn.apply(undefined, args);
          }
        }], [{
          key: 'instance',
          value: new FactoryActivator(),
          enumerable: true
        }]);

        return FactoryActivator;
      })();

      _export('FactoryActivator', FactoryActivator);
    }
  };
});
System.register('src/index', ['github:aurelia/metadata@0.5.0', 'src/metadata', 'src/container'], function (_export) {
  var Decorators, Metadata, TransientRegistration, SingletonRegistration, FactoryActivator, emptyParameters;

  _export('autoinject', autoinject);

  _export('inject', inject);

  _export('registration', registration);

  _export('transient', transient);

  _export('singleton', singleton);

  _export('instanceActivator', instanceActivator);

  _export('factory', factory);

  function autoinject(target) {
    var deco = function deco(target) {
      target.inject = Reflect.getOwnMetadata(Metadata.paramTypes, target) || emptyParameters;
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
      Reflect.defineMetadata(Metadata.registration, value, target);
    };
  }

  function transient(key) {
    return registration(new TransientRegistration(key));
  }

  function singleton(keyOrRegisterInChild) {
    var registerInChild = arguments[1] === undefined ? false : arguments[1];

    return registration(new SingletonRegistration(keyOrRegisterInChild, registerInChild));
  }

  function instanceActivator(value) {
    return function (target) {
      Reflect.defineMetadata(Metadata.instanceActivator, value, target);
    };
  }

  function factory() {
    return instanceActivator(FactoryActivator.instance);
  }

  return {
    setters: [function (_githubAureliaMetadata050) {
      Decorators = _githubAureliaMetadata050.Decorators;
      Metadata = _githubAureliaMetadata050.Metadata;
    }, function (_srcMetadata) {
      TransientRegistration = _srcMetadata.TransientRegistration;
      SingletonRegistration = _srcMetadata.SingletonRegistration;
      FactoryActivator = _srcMetadata.FactoryActivator;
      emptyParameters = _srcMetadata.emptyParameters;

      _export('TransientRegistration', _srcMetadata.TransientRegistration);

      _export('SingletonRegistration', _srcMetadata.SingletonRegistration);

      _export('Resolver', _srcMetadata.Resolver);

      _export('Lazy', _srcMetadata.Lazy);

      _export('All', _srcMetadata.All);

      _export('Optional', _srcMetadata.Optional);

      _export('Parent', _srcMetadata.Parent);

      _export('ClassActivator', _srcMetadata.ClassActivator);

      _export('FactoryActivator', _srcMetadata.FactoryActivator);
    }, function (_srcContainer) {
      _export('Container', _srcContainer.Container);
    }],
    execute: function () {
      'use strict';

      Decorators.configure.simpleDecorator('autoinject', autoinject);
      Decorators.configure.parameterizedDecorator('inject', inject);
      Decorators.configure.parameterizedDecorator('registration', registration);
      Decorators.configure.parameterizedDecorator('transient', transient);
      Decorators.configure.parameterizedDecorator('singleton', singleton);
      Decorators.configure.parameterizedDecorator('instanceActivator', instanceActivator);
      Decorators.configure.parameterizedDecorator('factory', factory);
    }
  };
});
/**
 * A lightweight, extensible dependency injection container for JavaScript.
 *
 * @module dependency-injection
 */
System.register('src/exports', ['src/index', 'github:aurelia/metadata@0.5.0'], function (_export) {
    var Registration, TransientRegistration, SingletonRegistration, Resolver, Lazy, All, Optional, Parent, InstanceActivator, FactoryActivator, Container, inject, transient, singleton, factory, Decorators, Metadata, globalScope, DI;
    return {
        setters: [function (_srcIndex) {
            Registration = _srcIndex.Registration;
            TransientRegistration = _srcIndex.TransientRegistration;
            SingletonRegistration = _srcIndex.SingletonRegistration;
            Resolver = _srcIndex.Resolver;
            Lazy = _srcIndex.Lazy;
            All = _srcIndex.All;
            Optional = _srcIndex.Optional;
            Parent = _srcIndex.Parent;
            InstanceActivator = _srcIndex.InstanceActivator;
            FactoryActivator = _srcIndex.FactoryActivator;
            Container = _srcIndex.Container;
            inject = _srcIndex.inject;
            transient = _srcIndex.transient;
            singleton = _srcIndex.singleton;
            factory = _srcIndex.factory;
        }, function (_githubAureliaMetadata050) {
            Decorators = _githubAureliaMetadata050.Decorators;
            Metadata = _githubAureliaMetadata050.Metadata;
        }],
        execute: function () {

            // Stick on the modules that need to be exported.
            // You only need to require the top-level modules, browserify
            // will walk the dependency graph and load everything correctly
            'use strict';

            globalScope = globalScope || window;
            DI = globalScope.DI || {};

            DI.Registration = Registration;
            DI.TransientRegistration = TransientRegistration;
            DI.SingletonRegistration = SingletonRegistration;
            DI.Resolver = Resolver;
            DI.Lazy = Lazy;
            DI.All = All;
            DI.Optional = Optional;
            DI.Parent = Parent;
            DI.InstanceActivator = InstanceActivator;
            DI.FactoryActivator = FactoryActivator;
            DI.Container = Container;
            DI.inject = inject;
            DI.transient = transient;
            DI.singleton = singleton;
            DI.factory = factory;

            DI.Decorators = Decorators;
            DI.Metadata = Metadata;

            // Replace/Create the global namespace
            globalScope.DI = DI;
        }
    };
});
});