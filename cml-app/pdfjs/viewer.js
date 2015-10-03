/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals PDFJS, PDFBug, FirefoxCom, Stats, Cache, ProgressBar,
           getFileName, getPDFFileNameFromURL,
           PDFHistory, Preferences, ViewHistory, Stats,
           URL, noContextMenuHandler,
           Promise, PDFLinkService,
           OverlayManager, PDFViewer,
           PDFRenderingQueue, parseQueryString,
           RenderingStates, UNKNOWN_SCALE, DEFAULT_SCALE_VALUE,
           IGNORE_CURRENT_POSITION_ON_ZOOM: true */

'use strict';

var DEFAULT_URL = 'compressed.tracemonkey-pldi-09.pdf';
var DEFAULT_SCALE_DELTA = 1.1;
var MIN_SCALE = 0.25;
var MAX_SCALE = 10.0;
var VIEW_HISTORY_MEMORY = 20;
var SCALE_SELECT_CONTAINER_PADDING = 8;
var SCALE_SELECT_PADDING = 22;
var PAGE_NUMBER_LOADING_INDICATOR = 'visiblePageIsLoading';
var DISABLE_AUTO_FETCH_LOADING_BAR_TIMEOUT = 5000;

PDFJS.imageResourcesPath = './pdfjs/images/';
  PDFJS.workerSrc = './pdfjs/pdfjs/pdf.worker.js';

var mozL10n = document.mozL10n || document.webL10n;

var CSS_UNITS = 96.0 / 72.0;
var DEFAULT_SCALE_VALUE = 'page-fit';
var DEFAULT_SCALE = 1.0;
var UNKNOWN_SCALE = 0;
var MAX_AUTO_SCALE = 1.25;
var SCROLLBAR_PADDING = 40;
var VERTICAL_PADDING = 5;

// optimised CSS custom property getter/setter
var CustomStyle = (function CustomStyleClosure() {

  // As noted on: http://www.zachstronaut.com/posts/2009/02/17/
  //              animate-css-transforms-firefox-webkit.html
  // in some versions of IE9 it is critical that ms appear in this list
  // before Moz
  var prefixes = ['ms', 'Moz', 'Webkit', 'O'];
  var _cache = {};

  function CustomStyle() {}

  CustomStyle.getProp = function get(propName, element) {
    // check cache only when no element is given
    if (arguments.length === 1 && typeof _cache[propName] === 'string') {
      return _cache[propName];
    }

    element = element || document.documentElement;
    var style = element.style, prefixed, uPropName;

    // test standard property first
    if (typeof style[propName] === 'string') {
      return (_cache[propName] = propName);
    }

    // capitalize
    uPropName = propName.charAt(0).toUpperCase() + propName.slice(1);

    // test vendor specific properties
    for (var i = 0, l = prefixes.length; i < l; i++) {
      prefixed = prefixes[i] + uPropName;
      if (typeof style[prefixed] === 'string') {
        return (_cache[propName] = prefixed);
      }
    }

    //if all fails then set to undefined
    return (_cache[propName] = 'undefined');
  };

  CustomStyle.setProp = function set(propName, element, str) {
    var prop = this.getProp(propName);
    if (prop !== 'undefined') {
      element.style[prop] = str;
    }
  };

  return CustomStyle;
})();

function getFileName(url) {
  var anchor = url.indexOf('#');
  var query = url.indexOf('?');
  var end = Math.min(
    anchor > 0 ? anchor : url.length,
    query > 0 ? query : url.length);
  return url.substring(url.lastIndexOf('/', end) + 1, end);
}

/**
 * Returns scale factor for the canvas. It makes sense for the HiDPI displays.
 * @return {Object} The object with horizontal (sx) and vertical (sy)
                    scales. The scaled property is set to false if scaling is
                    not required, true otherwise.
 */
function getOutputScale(ctx) {
  var devicePixelRatio = window.devicePixelRatio || 1;
  var backingStoreRatio = ctx.webkitBackingStorePixelRatio ||
                          ctx.mozBackingStorePixelRatio ||
                          ctx.msBackingStorePixelRatio ||
                          ctx.oBackingStorePixelRatio ||
                          ctx.backingStorePixelRatio || 1;
  var pixelRatio = devicePixelRatio / backingStoreRatio;
  return {
    sx: pixelRatio,
    sy: pixelRatio,
    scaled: pixelRatio !== 1
  };
}

/**
 * Scrolls specified element into view of its parent.
 * element {Object} The element to be visible.
 * spot {Object} An object with optional top and left properties,
 *               specifying the offset from the top left edge.
 */
function scrollIntoView(element, spot) {
  // Assuming offsetParent is available (it's not available when viewer is in
  // hidden iframe or object). We have to scroll: if the offsetParent is not set
  // producing the error. See also animationStartedClosure.
  var parent = element.offsetParent;
  var offsetY = element.offsetTop + element.clientTop;
  var offsetX = element.offsetLeft + element.clientLeft;
  if (!parent) {
    console.error('offsetParent is not set -- cannot scroll');
    return;
  }
  while (parent.clientHeight === parent.scrollHeight) {
    if (parent.dataset._scaleY) {
      offsetY /= parent.dataset._scaleY;
      offsetX /= parent.dataset._scaleX;
    }
    offsetY += parent.offsetTop;
    offsetX += parent.offsetLeft;
    parent = parent.offsetParent;
    if (!parent) {
      return; // no need to scroll
    }
  }
  if (spot) {
    if (spot.top !== undefined) {
      offsetY += spot.top;
    }
    if (spot.left !== undefined) {
      offsetX += spot.left;
      parent.scrollLeft = offsetX;
    }
  }
  parent.scrollTop = offsetY;
}

/**
 * Helper function to start monitoring the scroll event and converting them into
 * PDF.js friendly one: with scroll debounce and scroll direction.
 */
function watchScroll(viewAreaElement, callback) {
  var debounceScroll = function debounceScroll(evt) {
    if (rAF) {
      return;
    }
    // schedule an invocation of scroll for next animation frame.
    rAF = window.requestAnimationFrame(function viewAreaElementScrolled() {
      rAF = null;

      var currentY = viewAreaElement.scrollTop;
      var lastY = state.lastY;
      if (currentY !== lastY) {
        state.down = currentY > lastY;
      }
      state.lastY = currentY;
      callback(state);
    });
  };

  var state = {
    down: true,
    lastY: viewAreaElement.scrollTop,
    _eventHandler: debounceScroll
  };

  var rAF = null;
  viewAreaElement.addEventListener('scroll', debounceScroll, true);
  return state;
}

/**
 * Helper function to parse query string (e.g. ?param1=value&parm2=...).
 */
function parseQueryString(query) {
  var parts = query.split('&');
  var params = {};
  for (var i = 0, ii = parts.length; i < ii; ++i) {
    var param = parts[i].split('=');
    var key = param[0].toLowerCase();
    var value = param.length > 1 ? param[1] : null;
    params[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return params;
}

/**
 * Use binary search to find the index of the first item in a given array which
 * passes a given condition. The items are expected to be sorted in the sense
 * that if the condition is true for one item in the array, then it is also true
 * for all following items.
 *
 * @returns {Number} Index of the first array element to pass the test,
 *                   or |items.length| if no such element exists.
 */
function binarySearchFirstItem(items, condition) {
  var minIndex = 0;
  var maxIndex = items.length - 1;

  if (items.length === 0 || !condition(items[maxIndex])) {
    return items.length;
  }
  if (condition(items[minIndex])) {
    return minIndex;
  }

  while (minIndex < maxIndex) {
    var currentIndex = (minIndex + maxIndex) >> 1;
    var currentItem = items[currentIndex];
    if (condition(currentItem)) {
      maxIndex = currentIndex;
    } else {
      minIndex = currentIndex + 1;
    }
  }
  return minIndex; /* === maxIndex */
}

/**
 * Generic helper to find out what elements are visible within a scroll pane.
 */
function getVisibleElements(scrollEl, views, sortByVisibility) {
  var top = scrollEl.scrollTop, bottom = top + scrollEl.clientHeight;
  var left = scrollEl.scrollLeft, right = left + scrollEl.clientWidth;

  function isElementBottomBelowViewTop(view) {
    var element = view.div;
    var elementBottom =
      element.offsetTop + element.clientTop + element.clientHeight;
    return elementBottom > top;
  }

  var visible = [], view, element;
  var currentHeight, viewHeight, hiddenHeight, percentHeight;
  var currentWidth, viewWidth;
  var firstVisibleElementInd = (views.length === 0) ? 0 :
    binarySearchFirstItem(views, isElementBottomBelowViewTop);

  for (var i = firstVisibleElementInd, ii = views.length; i < ii; i++) {
    view = views[i];
    element = view.div;
    currentHeight = element.offsetTop + element.clientTop;
    viewHeight = element.clientHeight;

    if (currentHeight > bottom) {
      break;
    }

    currentWidth = element.offsetLeft + element.clientLeft;
    viewWidth = element.clientWidth;
    if (currentWidth + viewWidth < left || currentWidth > right) {
      continue;
    }
    hiddenHeight = Math.max(0, top - currentHeight) +
      Math.max(0, currentHeight + viewHeight - bottom);
    percentHeight = ((viewHeight - hiddenHeight) * 100 / viewHeight) | 0;

    visible.push({
      id: view.id,
      x: currentWidth,
      y: currentHeight,
      view: view,
      percent: percentHeight
    });
  }

  var first = visible[0];
  var last = visible[visible.length - 1];

  if (sortByVisibility) {
    visible.sort(function(a, b) {
      var pc = a.percent - b.percent;
      if (Math.abs(pc) > 0.001) {
        return -pc;
      }
      return a.id - b.id; // ensure stability
    });
  }
  return {first: first, last: last, views: visible};
}

/**
 * Event handler to suppress context menu.
 */
function noContextMenuHandler(e) {
  e.preventDefault();
}

/**
 * Returns the filename or guessed filename from the url (see issue 3455).
 * url {String} The original PDF location.
 * @return {String} Guessed PDF file name.
 */
function getPDFFileNameFromURL(url) {
  var reURI = /^(?:([^:]+:)?\/\/[^\/]+)?([^?#]*)(\?[^#]*)?(#.*)?$/;
  //            SCHEME      HOST         1.PATH  2.QUERY   3.REF
  // Pattern to get last matching NAME.pdf
  var reFilename = /[^\/?#=]+\.pdf\b(?!.*\.pdf\b)/i;
  var splitURI = reURI.exec(url);
  var suggestedFilename = reFilename.exec(splitURI[1]) ||
                           reFilename.exec(splitURI[2]) ||
                           reFilename.exec(splitURI[3]);
  if (suggestedFilename) {
    suggestedFilename = suggestedFilename[0];
    if (suggestedFilename.indexOf('%') !== -1) {
      // URL-encoded %2Fpath%2Fto%2Ffile.pdf should be file.pdf
      try {
        suggestedFilename =
          reFilename.exec(decodeURIComponent(suggestedFilename))[0];
      } catch(e) { // Possible (extremely rare) errors:
        // URIError "Malformed URI", e.g. for "%AA.pdf"
        // TypeError "null has no properties", e.g. for "%2F.pdf"
      }
    }
  }
  return suggestedFilename || 'document.pdf';
}

var ProgressBar = (function ProgressBarClosure() {

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  function ProgressBar(id, opts) {
    this.visible = true;

    // Fetch the sub-elements for later.
    this.div = document.querySelector(id + ' .progress');

    // Get the loading bar element, so it can be resized to fit the viewer.
    this.bar = this.div.parentNode;

    // Get options, with sensible defaults.
    this.height = opts.height || 100;
    this.width = opts.width || 100;
    this.units = opts.units || '%';

    // Initialize heights.
    this.div.style.height = this.height + this.units;
    this.percent = 0;
  }

  ProgressBar.prototype = {

    updateBar: function ProgressBar_updateBar() {
      if (this._indeterminate) {
        this.div.classList.add('indeterminate');
        this.div.style.width = this.width + this.units;
        return;
      }

      this.div.classList.remove('indeterminate');
      var progressSize = this.width * this._percent / 100;
      this.div.style.width = progressSize + this.units;
    },

    get percent() {
      return this._percent;
    },

    set percent(val) {
      this._indeterminate = isNaN(val);
      this._percent = clamp(val, 0, 100);
      this.updateBar();
    },

    setWidth: function ProgressBar_setWidth(viewer) {
      if (viewer) {
        var container = viewer.parentNode;
        var scrollbarWidth = container.offsetWidth - viewer.offsetWidth;
        if (scrollbarWidth > 0) {
          this.bar.setAttribute('style', 'width: calc(100% - ' +
                                         scrollbarWidth + 'px);');
        }
      }
    },

    hide: function ProgressBar_hide() {
      if (!this.visible) {
        return;
      }
      this.visible = false;
      this.bar.classList.add('hidden');
      document.body.classList.remove('loadingInProgress');
    },

    show: function ProgressBar_show() {
      if (this.visible) {
        return;
      }
      this.visible = true;
      document.body.classList.add('loadingInProgress');
      this.bar.classList.remove('hidden');
    }
  };

  return ProgressBar;
})();



var DEFAULT_PREFERENCES = {
  showPreviousViewOnLoad: true,
  defaultZoomValue: '',
  enableHandToolOnLoad: false,
  enableWebGL: false,
  pdfBugEnabled: false,
  disableRange: false,
  disableStream: false,
  disableAutoFetch: false,
  disableFontFace: false,
  disableTextLayer: false,
  useOnlyCssZoom: false
};

/**
 * Preferences - Utility for storing persistent settings.
 *   Used for settings that should be applied to all opened documents,
 *   or every time the viewer is loaded.
 */
var Preferences = {
  prefs: Object.create(DEFAULT_PREFERENCES),
  isInitializedPromiseResolved: false,
  initializedPromise: null,

  /**
   * Initialize and fetch the current preference values from storage.
   * @return {Promise} A promise that is resolved when the preferences
   *                   have been initialized.
   */
  initialize: function preferencesInitialize() {
    return this.initializedPromise =
        this._readFromStorage(DEFAULT_PREFERENCES).then(function(prefObj) {
      this.isInitializedPromiseResolved = true;
      if (prefObj) {
        this.prefs = prefObj;
      }
    }.bind(this));
  },

  /**
   * Stub function for writing preferences to storage.
   * NOTE: This should be overridden by a build-specific function defined below.
   * @param {Object} prefObj The preferences that should be written to storage.
   * @return {Promise} A promise that is resolved when the preference values
   *                   have been written.
   */
  _writeToStorage: function preferences_writeToStorage(prefObj) {
    return Promise.resolve();
  },

  /**
   * Stub function for reading preferences from storage.
   * NOTE: This should be overridden by a build-specific function defined below.
   * @param {Object} prefObj The preferences that should be read from storage.
   * @return {Promise} A promise that is resolved with an {Object} containing
   *                   the preferences that have been read.
   */
  _readFromStorage: function preferences_readFromStorage(prefObj) {
    return Promise.resolve();
  },

  /**
   * Reset the preferences to their default values and update storage.
   * @return {Promise} A promise that is resolved when the preference values
   *                   have been reset.
   */
  reset: function preferencesReset() {
    return this.initializedPromise.then(function() {
      this.prefs = Object.create(DEFAULT_PREFERENCES);
      return this._writeToStorage(DEFAULT_PREFERENCES);
    }.bind(this));
  },

  /**
   * Replace the current preference values with the ones from storage.
   * @return {Promise} A promise that is resolved when the preference values
   *                   have been updated.
   */
  reload: function preferencesReload() {
    return this.initializedPromise.then(function () {
      this._readFromStorage(DEFAULT_PREFERENCES).then(function(prefObj) {
        if (prefObj) {
          this.prefs = prefObj;
        }
      }.bind(this));
    }.bind(this));
  },

  /**
   * Set the value of a preference.
   * @param {string} name The name of the preference that should be changed.
   * @param {boolean|number|string} value The new value of the preference.
   * @return {Promise} A promise that is resolved when the value has been set,
   *                   provided that the preference exists and the types match.
   */
  set: function preferencesSet(name, value) {
    return this.initializedPromise.then(function () {
      if (DEFAULT_PREFERENCES[name] === undefined) {
        throw new Error('preferencesSet: \'' + name + '\' is undefined.');
      } else if (value === undefined) {
        throw new Error('preferencesSet: no value is specified.');
      }
      var valueType = typeof value;
      var defaultType = typeof DEFAULT_PREFERENCES[name];

      if (valueType !== defaultType) {
        if (valueType === 'number' && defaultType === 'string') {
          value = value.toString();
        } else {
          throw new Error('Preferences_set: \'' + value + '\' is a \"' +
                          valueType + '\", expected \"' + defaultType + '\".');
        }
      } else {
        if (valueType === 'number' && (value | 0) !== value) {
          throw new Error('Preferences_set: \'' + value +
                          '\' must be an \"integer\".');
        }
      }
      this.prefs[name] = value;
      return this._writeToStorage(this.prefs);
    }.bind(this));
  },

  /**
   * Get the value of a preference.
   * @param {string} name The name of the preference whose value is requested.
   * @return {Promise} A promise that is resolved with a {boolean|number|string}
   *                   containing the value of the preference.
   */
  get: function preferencesGet(name) {
    return this.initializedPromise.then(function () {
      var defaultValue = DEFAULT_PREFERENCES[name];

      if (defaultValue === undefined) {
        throw new Error('preferencesGet: \'' + name + '\' is undefined.');
      } else {
        var prefValue = this.prefs[name];

        if (prefValue !== undefined) {
          return prefValue;
        }
      }
      return defaultValue;
    }.bind(this));
  }
};


Preferences._writeToStorage = function (prefObj) {
  return new Promise(function (resolve) {
    localStorage.setItem('pdfjs.preferences', JSON.stringify(prefObj));
    resolve();
  });
};

Preferences._readFromStorage = function (prefObj) {
  return new Promise(function (resolve) {
    var readPrefs = JSON.parse(localStorage.getItem('pdfjs.preferences'));
    resolve(readPrefs);
  });
};


/**
 * View History - This is a utility for saving various view parameters for
 *                recently opened files.
 *
 * The way that the view parameters are stored depends on how PDF.js is built,
 * for 'node make <flag>' the following cases exist:
 *  - FIREFOX or MOZCENTRAL - uses sessionStorage.
 *  - GENERIC or CHROME     - uses localStorage, if it is available.
 */
var ViewHistory = (function ViewHistoryClosure() {
  function ViewHistory(fingerprint) {
    this.fingerprint = fingerprint;
    this.isInitializedPromiseResolved = false;
    this.initializedPromise =
        this._readFromStorage().then(function (databaseStr) {
      this.isInitializedPromiseResolved = true;

      var database = JSON.parse(databaseStr || '{}');
      if (!('files' in database)) {
        database.files = [];
      }
      if (database.files.length >= VIEW_HISTORY_MEMORY) {
        database.files.shift();
      }
      var index;
      for (var i = 0, length = database.files.length; i < length; i++) {
        var branch = database.files[i];
        if (branch.fingerprint === this.fingerprint) {
          index = i;
          break;
        }
      }
      if (typeof index !== 'number') {
        index = database.files.push({fingerprint: this.fingerprint}) - 1;
      }
      this.file = database.files[index];
      this.database = database;
    }.bind(this));
  }

  ViewHistory.prototype = {
    _writeToStorage: function ViewHistory_writeToStorage() {
      return new Promise(function (resolve) {
        var databaseStr = JSON.stringify(this.database);


        localStorage.setItem('database', databaseStr);
        resolve();
      }.bind(this));
    },

    _readFromStorage: function ViewHistory_readFromStorage() {
      return new Promise(function (resolve) {

        resolve(localStorage.getItem('database'));
      });
    },

    set: function ViewHistory_set(name, val) {
      if (!this.isInitializedPromiseResolved) {
        return;
      }
      this.file[name] = val;
      return this._writeToStorage();
    },

    setMultiple: function ViewHistory_setMultiple(properties) {
      if (!this.isInitializedPromiseResolved) {
        return;
      }
      for (var name in properties) {
        this.file[name] = properties[name];
      }
      return this._writeToStorage();
    },

    get: function ViewHistory_get(name, defaultValue) {
      if (!this.isInitializedPromiseResolved) {
        return defaultValue;
      }
      return this.file[name] || defaultValue;
    }
  };

  return ViewHistory;
})();

var FIND_SCROLL_OFFSET_TOP = -50;
var FIND_SCROLL_OFFSET_LEFT = -400;


/**
 * Performs navigation functions inside PDF, such as opening specified page,
 * or destination.
 * @class
 * @implements {IPDFLinkService}
 */
var PDFLinkService = (function () {
  /**
   * @constructs PDFLinkService
   */
  function PDFLinkService() {
    this.baseUrl = null;
    this.pdfDocument = null;
    this.pdfViewer = null;
    this.pdfHistory = null;

    this._pagesRefCache = null;
  }

  PDFLinkService.prototype = {
    setDocument: function PDFLinkService_setDocument(pdfDocument, baseUrl) {
      this.baseUrl = baseUrl;
      this.pdfDocument = pdfDocument;
      this._pagesRefCache = Object.create(null);
    },

    setViewer: function PDFLinkService_setViewer(pdfViewer) {
      this.pdfViewer = pdfViewer;
    },

    setHistory: function PDFLinkService_setHistory(pdfHistory) {
      this.pdfHistory = pdfHistory;
    },

    /**
     * @returns {number}
     */
    get pagesCount() {
      return this.pdfDocument.numPages;
    },

    /**
     * @returns {number}
     */
    get page() {
      return this.pdfViewer.currentPageNumber;
    },

    /**
     * @param {number} value
     */
    set page(value) {
      this.pdfViewer.currentPageNumber = value;
    },

    /**
     * @param dest - The PDF destination object.
     */
    navigateTo: function PDFLinkService_navigateTo(dest) {
      var destString = '';
      var self = this;

      var goToDestination = function(destRef) {
        // dest array looks like that: <page-ref> </XYZ|FitXXX> <args..>
        var pageNumber = destRef instanceof Object ?
          self._pagesRefCache[destRef.num + ' ' + destRef.gen + ' R'] :
          (destRef + 1);
        if (pageNumber) {
          if (pageNumber > self.pagesCount) {
            pageNumber = self.pagesCount;
          }
          self.pdfViewer.scrollPageIntoView(pageNumber, dest);

          if (self.pdfHistory) {
            // Update the browsing history.
            self.pdfHistory.push({
              dest: dest,
              hash: destString,
              page: pageNumber
            });
          }
        } else {
          self.pdfDocument.getPageIndex(destRef).then(function (pageIndex) {
            var pageNum = pageIndex + 1;
            var cacheKey = destRef.num + ' ' + destRef.gen + ' R';
            self._pagesRefCache[cacheKey] = pageNum;
            goToDestination(destRef);
          });
        }
      };

      var destinationPromise;
      if (typeof dest === 'string') {
        destString = dest;
        destinationPromise = this.pdfDocument.getDestination(dest);
      } else {
        destinationPromise = Promise.resolve(dest);
      }
      destinationPromise.then(function(destination) {
        dest = destination;
        if (!(destination instanceof Array)) {
          return; // invalid destination
        }
        goToDestination(destination[0]);
      });
    },

    /**
     * @param dest - The PDF destination object.
     * @returns {string} The hyperlink to the PDF object.
     */
    getDestinationHash: function PDFLinkService_getDestinationHash(dest) {
      if (typeof dest === 'string') {
        return this.getAnchorUrl('#' + escape(dest));
      }
      if (dest instanceof Array) {
        var destRef = dest[0]; // see navigateTo method for dest format
        var pageNumber = destRef instanceof Object ?
          this._pagesRefCache[destRef.num + ' ' + destRef.gen + ' R'] :
          (destRef + 1);
        if (pageNumber) {
          var pdfOpenParams = this.getAnchorUrl('#page=' + pageNumber);
          var destKind = dest[1];
          if (typeof destKind === 'object' && 'name' in destKind &&
              destKind.name === 'XYZ') {
            var scale = (dest[4] || this.pdfViewer.currentScaleValue);
            var scaleNumber = parseFloat(scale);
            if (scaleNumber) {
              scale = scaleNumber * 100;
            }
            pdfOpenParams += '&zoom=' + scale;
            if (dest[2] || dest[3]) {
              pdfOpenParams += ',' + (dest[2] || 0) + ',' + (dest[3] || 0);
            }
          }
          return pdfOpenParams;
        }
      }
      return '';
    },

    /**
     * Prefix the full url on anchor links to make sure that links are resolved
     * relative to the current URL instead of the one defined in <base href>.
     * @param {String} anchor The anchor hash, including the #.
     * @returns {string} The hyperlink to the PDF object.
     */
    getAnchorUrl: function PDFLinkService_getAnchorUrl(anchor) {
      return (this.baseUrl || '') + anchor;
    },

    /**
     * @param {string} hash
     */
    setHash: function PDFLinkService_setHash(hash) {
      if (hash.indexOf('=') >= 0) {
        var params = parseQueryString(hash);
        // borrowing syntax from "Parameters for Opening PDF Files"
        if ('nameddest' in params) {
          if (this.pdfHistory) {
            this.pdfHistory.updateNextHashParam(params.nameddest);
          }
          this.navigateTo(params.nameddest);
          return;
        }
        var pageNumber, dest;
        if ('page' in params) {
          pageNumber = (params.page | 0) || 1;
        }
        if ('zoom' in params) {
          // Build the destination array.
          var zoomArgs = params.zoom.split(','); // scale,left,top
          var zoomArg = zoomArgs[0];
          var zoomArgNumber = parseFloat(zoomArg);

          if (zoomArg.indexOf('Fit') === -1) {
            // If the zoomArg is a number, it has to get divided by 100. If it's
            // a string, it should stay as it is.
            dest = [null, { name: 'XYZ' },
                    zoomArgs.length > 1 ? (zoomArgs[1] | 0) : null,
                    zoomArgs.length > 2 ? (zoomArgs[2] | 0) : null,
                    (zoomArgNumber ? zoomArgNumber / 100 : zoomArg)];
          } else {
            if (zoomArg === 'Fit' || zoomArg === 'FitB') {
              dest = [null, { name: zoomArg }];
            } else if ((zoomArg === 'FitH' || zoomArg === 'FitBH') ||
                       (zoomArg === 'FitV' || zoomArg === 'FitBV')) {
              dest = [null, { name: zoomArg },
                      zoomArgs.length > 1 ? (zoomArgs[1] | 0) : null];
            } else if (zoomArg === 'FitR') {
              if (zoomArgs.length !== 5) {
                console.error('PDFLinkService_setHash: ' +
                              'Not enough parameters for \'FitR\'.');
              } else {
                dest = [null, { name: zoomArg },
                        (zoomArgs[1] | 0), (zoomArgs[2] | 0),
                        (zoomArgs[3] | 0), (zoomArgs[4] | 0)];
              }
            } else {
              console.error('PDFLinkService_setHash: \'' + zoomArg +
                            '\' is not a valid zoom value.');
            }
          }
        }
        if (dest) {
          this.pdfViewer.scrollPageIntoView(pageNumber || this.page, dest);
        } else if (pageNumber) {
          this.page = pageNumber; // simple page
        }
      } else if (/^\d+$/.test(hash)) { // page number
        this.page = hash;
      } else { // named destination
        if (this.pdfHistory) {
          this.pdfHistory.updateNextHashParam(unescape(hash));
        }
        this.navigateTo(unescape(hash));
      }
    },

    /**
     * @param {string} action
     */
    executeNamedAction: function PDFLinkService_executeNamedAction(action) {
      // See PDF reference, table 8.45 - Named action
      switch (action) {
        case 'GoBack':
          if (this.pdfHistory) {
            this.pdfHistory.back();
          }
          break;

        case 'GoForward':
          if (this.pdfHistory) {
            this.pdfHistory.forward();
          }
          break;

        case 'NextPage':
          this.page++;
          break;

        case 'PrevPage':
          this.page--;
          break;

        default:
          break; // No action according to spec
      }

      var event = document.createEvent('CustomEvent');
      event.initCustomEvent('namedaction', true, true, {
        action: action
      });
      this.pdfViewer.container.dispatchEvent(event);
    },

    /**
     * @param {number} pageNum - page number.
     * @param {Object} pageRef - reference to the page.
     */
    cachePageRef: function PDFLinkService_cachePageRef(pageNum, pageRef) {
      var refStr = pageRef.num + ' ' + pageRef.gen + ' R';
      this._pagesRefCache[refStr] = pageNum;
    }
  };

  return PDFLinkService;
})();


var PDFHistory = (function () {
  function PDFHistory(options) {
    this.linkService = options.linkService;

    this.initialized = false;
    this.initialDestination = null;
  }

  PDFHistory.prototype = {
    /**
     * @param {string} fingerprint
     * @param {IPDFLinkService} linkService
     */
    initialize: function pdfHistoryInitialize(fingerprint) {
      this.initialized = true;
      this.reInitialized = false;
      this.allowHashChange = true;
      this.historyUnlocked = true;

      this.previousHash = window.location.hash.substring(1);
      this.currentPage = 0;
      this.previousPage = 0;
      this.nextHashParam = '';

      this.fingerprint = fingerprint;
      this.currentUid = this.uid = 0;
      this.current = {};

      var state = window.history.state;
      if (this._isStateObjectDefined(state)) {
        // This corresponds to navigating back to the document
        // from another page in the browser history.
        if (state.target.dest) {
          this.initialDestination = state.target.dest;
        } 
        this.currentUid = state.uid;
        this.uid = state.uid + 1;
        this.current = state.target;
      } else {
        // This corresponds to the loading of a new document.
        if (state && state.fingerprint &&
          this.fingerprint !== state.fingerprint) {
          // Reinitialize the browsing history when a new document
          // is opened in the web viewer.
          this.reInitialized = true;
        }
        this._pushOrReplaceState({fingerprint: this.fingerprint}, true);
      }

      var self = this;
      window.addEventListener('popstate', function pdfHistoryPopstate(evt) {
        evt.preventDefault();
        evt.stopPropagation();

        if (!self.historyUnlocked) {
          return;
        }
        if (evt.state) {
          // Move back/forward in the history.
          self._goTo(evt.state);
        } else {
          // Handle the user modifying the hash of a loaded document.
          self.previousHash = window.location.hash.substring(1);

          // If the history is empty when the hash changes,
          // update the previous entry in the browser history.
          if (self.uid === 0) {
            var previousParams = (self.previousHash) ?
            {page: self.currentPage} :
            {page: 1};
            self.historyUnlocked = false;
            self.allowHashChange = false;
            window.history.back();
            self._pushToHistory(previousParams, false, true);
            window.history.forward();
            self.historyUnlocked = true;
          }
          self._pushToHistory({hash: self.previousHash}, false, true);
        }
      }, false);

      function pdfHistoryBeforeUnload() {
        var previousParams = self._getPreviousParams(null, true);
        if (previousParams) {
          var replacePrevious = (!self.current.dest &&
          self.current.hash !== self.previousHash);
          self._pushToHistory(previousParams, false, replacePrevious);
        }
        // Remove the event listener when navigating away from the document,
        // since 'beforeunload' prevents Firefox from caching the document.
        window.removeEventListener('beforeunload', pdfHistoryBeforeUnload,
                                   false);
      }

      window.addEventListener('beforeunload', pdfHistoryBeforeUnload, false);

      window.addEventListener('pageshow', function pdfHistoryPageShow(evt) {
        // If the entire viewer (including the PDF file) is cached in
        // the browser, we need to reattach the 'beforeunload' event listener
        // since the 'DOMContentLoaded' event is not fired on 'pageshow'.
        window.addEventListener('beforeunload', pdfHistoryBeforeUnload, false);
      }, false);
    },

    clearHistoryState: function pdfHistory_clearHistoryState() {
      this._pushOrReplaceState(null, true);
    },

    _isStateObjectDefined: function pdfHistory_isStateObjectDefined(state) {
      return (state && state.uid >= 0 &&
      state.fingerprint && this.fingerprint === state.fingerprint &&
      state.target && state.target.hash) ? true : false;
    },

    _pushOrReplaceState: function pdfHistory_pushOrReplaceState(stateObj,
                                                                replace) {
      if (replace) {
        window.history.replaceState(stateObj, '', document.URL);
      } else {
        window.history.pushState(stateObj, '', document.URL);
      }
    },

    get isHashChangeUnlocked() {
      if (!this.initialized) {
        return true;
      }
      // If the current hash changes when moving back/forward in the history,
      // this will trigger a 'popstate' event *as well* as a 'hashchange' event.
      // Since the hash generally won't correspond to the exact the position
      // stored in the history's state object, triggering the 'hashchange' event
      // can thus corrupt the browser history.
      //
      // When the hash changes during a 'popstate' event, we *only* prevent the
      // first 'hashchange' event and immediately reset allowHashChange.
      // If it is not reset, the user would not be able to change the hash.

      var temp = this.allowHashChange;
      this.allowHashChange = true;
      return temp;
    },

    updateNextHashParam: function pdfHistoryUpdateNextHashParam(param) {
      if (this.initialized) {
        this.nextHashParam = param;
      }
    },

    push: function pdfHistoryPush(params) {
      if (!(this.initialized && this.historyUnlocked)) {
        return;
      }
      if (params.dest && !params.hash) {
        params.hash = (this.current.hash && this.current.dest &&
        this.current.dest === params.dest) ?
          this.current.hash :
          this.linkService.getDestinationHash(params.dest).split('#')[1];
      }
      if (params.page) {
        params.page |= 0;
      }
      if (this.nextHashParam) {
        if (this.nextHashParam === params.hash) {
          this.nextHashParam = null;
          return;
        } else {
          this.nextHashParam = null;
        }
      }

      if (params.hash) {
        if (this.current.hash) {
          if (this.current.hash !== params.hash) {
            this._pushToHistory(params, true);
          } else {
            if (!this.current.page && params.page) {
              this._pushToHistory(params, false, true);
            }
          }
        } else {
          this._pushToHistory(params, true);
        }
      } else if (this.current.page && params.page &&
        this.current.page !== params.page) {
        this._pushToHistory(params, true);
      }
    },

    _getPreviousParams: function pdfHistory_getPreviousParams(onlyCheckPage,
                                                              beforeUnload) {
      if (!(this.currentPage)) {
        return null;
      } 
      if (this.uid > 0 && !(this.previousPage)) {
        // Prevent the history from getting stuck in the current state,
        // effectively preventing the user from going back/forward in
        // the history.
        //
        // This happens if the current position in the document didn't change
        // when the history was previously updated. The reasons for this are
        // either:
        // 1. The current zoom value is such that the document does not need to,
        //    or cannot, be scrolled to display the destination.
        // 2. The previous destination is broken, and doesn't actally point to a
        //    position within the document.
        //    (This is either due to a bad PDF generator, or the user making a
        //     mistake when entering a destination in the hash parameters.)
        return null;
      }
      if ((!this.current.dest && !onlyCheckPage) || beforeUnload) {
      } else if (this.current.page || onlyCheckPage) {
        if (this.previousPage === this.currentPage) {
          return null;
        }
      } else {
        return null;
      }
      var params = {page: this.currentPage};
      return params;
    },

    _stateObj: function pdfHistory_stateObj(params) {
      return {fingerprint: this.fingerprint, uid: this.uid, target: params};
    },

    _pushToHistory: function pdfHistory_pushToHistory(params,
                                                      addPrevious, overwrite) {
      if (!this.initialized) {
        return;
      }
      if (!params.hash && params.page) {
        params.hash = ('page=' + params.page);
      }
      if (addPrevious && !overwrite) {
        var previousParams = this._getPreviousParams();
        if (previousParams) {
          var replacePrevious = (!this.current.dest &&
          this.current.hash !== this.previousHash);
          this._pushToHistory(previousParams, false, replacePrevious);
        }
      }
      this._pushOrReplaceState(this._stateObj(params),
        (overwrite || this.uid === 0));
      this.currentUid = this.uid++;
      this.current = params;
    },

    _goTo: function pdfHistory_goTo(state) {
      if (!(this.initialized && this.historyUnlocked &&
        this._isStateObjectDefined(state))) {
        return;
      }
      if (!this.reInitialized && state.uid < this.currentUid) {
        var previousParams = this._getPreviousParams(true);
        if (previousParams) {
          this._pushToHistory(this.current, false);
          this._pushToHistory(previousParams, false);
          this.currentUid = state.uid;
          window.history.back();
          return;
        }
      }
      this.historyUnlocked = false;

      if (state.target.dest) {
        this.linkService.navigateTo(state.target.dest);
      } else {
        this.linkService.setHash(state.target.hash);
      }
      this.currentUid = state.uid;
      if (state.uid > this.uid) {
        this.uid = state.uid;
      }
      this.current = state.target;

      var currentHash = window.location.hash.substring(1);
      if (this.previousHash !== currentHash) {
        this.allowHashChange = false;
      }
      this.previousHash = currentHash;

      this.historyUnlocked = true;
    },

    back: function pdfHistoryBack() {
      this.go(-1);
    },

    forward: function pdfHistoryForward() {
      this.go(1);
    },

    go: function pdfHistoryGo(direction) {
      if (this.initialized && this.historyUnlocked) {
        var state = window.history.state;
        if (direction === -1 && state && state.uid > 0) {
          window.history.back();
        } else if (direction === 1 && state && state.uid < (this.uid - 1)) {
          window.history.forward();
        }
      }
    }
  };

  return PDFHistory;
})();


var DELAY_BEFORE_RESETTING_SWITCH_IN_PROGRESS = 1500; // in ms
var DELAY_BEFORE_HIDING_CONTROLS = 3000; // in ms


/* Copyright 2013 Rob Wu <gwnRob@gmail.com>
 * https://github.com/Rob--W/grab-to-pan.js
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var GrabToPan = (function GrabToPanClosure() {
  /**
   * Construct a GrabToPan instance for a given HTML element.
   * @param options.element {Element}
   * @param options.ignoreTarget {function} optional. See `ignoreTarget(node)`
   * @param options.onActiveChanged {function(boolean)} optional. Called
   *  when grab-to-pan is (de)activated. The first argument is a boolean that
   *  shows whether grab-to-pan is activated.
   */
  function GrabToPan(options) {
    this.element = options.element;
    this.document = options.element.ownerDocument;
    if (typeof options.ignoreTarget === 'function') {
      this.ignoreTarget = options.ignoreTarget;
    }
    this.onActiveChanged = options.onActiveChanged;

    // Bind the contexts to ensure that `this` always points to
    // the GrabToPan instance.
    this.activate = this.activate.bind(this);
    this.deactivate = this.deactivate.bind(this);
    this.toggle = this.toggle.bind(this);
    this._onmousedown = this._onmousedown.bind(this);
    this._onmousemove = this._onmousemove.bind(this);
    this._endPan = this._endPan.bind(this);

    // This overlay will be inserted in the document when the mouse moves during
    // a grab operation, to ensure that the cursor has the desired appearance.
    var overlay = this.overlay = document.createElement('div');
    overlay.className = 'grab-to-pan-grabbing';
  }
  GrabToPan.prototype = {
    /**
     * Class name of element which can be grabbed
     */
    CSS_CLASS_GRAB: 'grab-to-pan-grab',

    /**
     * Bind a mousedown event to the element to enable grab-detection.
     */
    activate: function GrabToPan_activate() {
      if (!this.active) {
        this.active = true;
        this.element.addEventListener('mousedown', this._onmousedown, true);
        this.element.classList.add(this.CSS_CLASS_GRAB);
        if (this.onActiveChanged) {
          this.onActiveChanged(true);
        }
      }
    },

    /**
     * Removes all events. Any pending pan session is immediately stopped.
     */
    deactivate: function GrabToPan_deactivate() {
      if (this.active) {
        this.active = false;
        this.element.removeEventListener('mousedown', this._onmousedown, true);
        this._endPan();
        this.element.classList.remove(this.CSS_CLASS_GRAB);
        if (this.onActiveChanged) {
          this.onActiveChanged(false);
        }
      }
    },

    toggle: function GrabToPan_toggle() {
      if (this.active) {
        this.deactivate();
      } else {
        this.activate();
      }
    },

    /**
     * Whether to not pan if the target element is clicked.
     * Override this method to change the default behaviour.
     *
     * @param node {Element} The target of the event
     * @return {boolean} Whether to not react to the click event.
     */
    ignoreTarget: function GrabToPan_ignoreTarget(node) {
      // Use matchesSelector to check whether the clicked element
      // is (a child of) an input element / link
      return node[matchesSelector](
        'a[href], a[href] *, input, textarea, button, button *, select, option'
      );
    },

    /**
     * @private
     */
    _onmousedown: function GrabToPan__onmousedown(event) {
      if (event.button !== 0 || this.ignoreTarget(event.target)) {
        return;
      }
      if (event.originalTarget) {
        try {
          /* jshint expr:true */
          event.originalTarget.tagName;
        } catch (e) {
          // Mozilla-specific: element is a scrollbar (XUL element)
          return;
        }
      }

      this.scrollLeftStart = this.element.scrollLeft;
      this.scrollTopStart = this.element.scrollTop;
      this.clientXStart = event.clientX;
      this.clientYStart = event.clientY;
      this.document.addEventListener('mousemove', this._onmousemove, true);
      this.document.addEventListener('mouseup', this._endPan, true);
      // When a scroll event occurs before a mousemove, assume that the user
      // dragged a scrollbar (necessary for Opera Presto, Safari and IE)
      // (not needed for Chrome/Firefox)
      this.element.addEventListener('scroll', this._endPan, true);
      event.preventDefault();
      event.stopPropagation();
      this.document.documentElement.classList.add(this.CSS_CLASS_GRABBING);

      var focusedElement = document.activeElement;
      if (focusedElement && !focusedElement.contains(event.target)) {
        focusedElement.blur();
      }
    },

    /**
     * @private
     */
    _onmousemove: function GrabToPan__onmousemove(event) {
      this.element.removeEventListener('scroll', this._endPan, true);
      if (isLeftMouseReleased(event)) {
        this._endPan();
        return;
      }
      var xDiff = event.clientX - this.clientXStart;
      var yDiff = event.clientY - this.clientYStart;
      this.element.scrollTop = this.scrollTopStart - yDiff;
      this.element.scrollLeft = this.scrollLeftStart - xDiff;
      if (!this.overlay.parentNode) {
        document.body.appendChild(this.overlay);
      }
    },

    /**
     * @private
     */
    _endPan: function GrabToPan__endPan() {
      this.element.removeEventListener('scroll', this._endPan, true);
      this.document.removeEventListener('mousemove', this._onmousemove, true);
      this.document.removeEventListener('mouseup', this._endPan, true);
      if (this.overlay.parentNode) {
        this.overlay.parentNode.removeChild(this.overlay);
      }
    }
  };

  // Get the correct (vendor-prefixed) name of the matches method.
  var matchesSelector;
  ['webkitM', 'mozM', 'msM', 'oM', 'm'].some(function(prefix) {
    var name = prefix + 'atches';
    if (name in document.documentElement) {
      matchesSelector = name;
    }
    name += 'Selector';
    if (name in document.documentElement) {
      matchesSelector = name;
    }
    return matchesSelector; // If found, then truthy, and [].some() ends.
  });

  // Browser sniffing because it's impossible to feature-detect
  // whether event.which for onmousemove is reliable
  var isNotIEorIsIE10plus = !document.documentMode || document.documentMode > 9;
  var chrome = window.chrome;
  var isChrome15OrOpera15plus = chrome && (chrome.webstore || chrome.app);
  //                                       ^ Chrome 15+       ^ Opera 15+
  var isSafari6plus = /Apple/.test(navigator.vendor) &&
                      /Version\/([6-9]\d*|[1-5]\d+)/.test(navigator.userAgent);

  /**
   * Whether the left mouse is not pressed.
   * @param event {MouseEvent}
   * @return {boolean} True if the left mouse button is not pressed.
   *                   False if unsure or if the left mouse button is pressed.
   */
  function isLeftMouseReleased(event) {
    if ('buttons' in event && isNotIEorIsIE10plus) {
      // http://www.w3.org/TR/DOM-Level-3-Events/#events-MouseEvent-buttons
      // Firefox 15+
      // Internet Explorer 10+
      return !(event.buttons | 1);
    }
    if (isChrome15OrOpera15plus || isSafari6plus) {
      // Chrome 14+
      // Opera 15+
      // Safari 6.0+
      return event.which === 0;
    }
  }

  return GrabToPan;
})();

var OverlayManager = {
  overlays: {},
  active: null,

  /**
   * @param {string} name The name of the overlay that is registered. This must
   *                 be equal to the ID of the overlay's DOM element.
   * @param {function} callerCloseMethod (optional) The method that, if present,
   *                   will call OverlayManager.close from the Object
   *                   registering the overlay. Access to this method is
   *                   necessary in order to run cleanup code when e.g.
   *                   the overlay is force closed. The default is null.
   * @param {boolean} canForceClose (optional) Indicates if opening the overlay
   *                  will close an active overlay. The default is false.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    registered.
   */
  register: function overlayManagerRegister(name,
                                            callerCloseMethod, canForceClose) {
    return new Promise(function (resolve) {
      var element, container;
      if (!name || !(element = document.getElementById(name)) ||
          !(container = element.parentNode)) {
        throw new Error('Not enough parameters.');
      } else if (this.overlays[name]) {
        throw new Error('The overlay is already registered.');
      }
      this.overlays[name] = { element: element,
                              container: container,
                              callerCloseMethod: (callerCloseMethod || null),
                              canForceClose: (canForceClose || false) };
      resolve();
    }.bind(this));
  },

  /**
   * @param {string} name The name of the overlay that is unregistered.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    unregistered.
   */
  unregister: function overlayManagerUnregister(name) {
    return new Promise(function (resolve) {
      if (!this.overlays[name]) {
        throw new Error('The overlay does not exist.');
      } else if (this.active === name) {
        throw new Error('The overlay cannot be removed while it is active.');
      }
      delete this.overlays[name];

      resolve();
    }.bind(this));
  },

  /**
   * @param {string} name The name of the overlay that should be opened.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    opened.
   */
  open: function overlayManagerOpen(name) {
    return new Promise(function (resolve) {
      if (!this.overlays[name]) {
        throw new Error('The overlay does not exist.');
      } else if (this.active) {
        if (this.overlays[name].canForceClose) {
          this._closeThroughCaller();
        } else if (this.active === name) {
          throw new Error('The overlay is already active.');
        } else {
          throw new Error('Another overlay is currently active.');
        }
      }
      this.active = name;
      this.overlays[this.active].element.classList.remove('hidden');
      this.overlays[this.active].container.classList.remove('hidden');

      window.addEventListener('keydown', this._keyDown);
      resolve();
    }.bind(this));
  },

  /**
   * @param {string} name The name of the overlay that should be closed.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    closed.
   */
  close: function overlayManagerClose(name) {
    return new Promise(function (resolve) {
      if (!this.overlays[name]) {
        throw new Error('The overlay does not exist.');
      } else if (!this.active) {
        throw new Error('The overlay is currently not active.');
      } else if (this.active !== name) {
        throw new Error('Another overlay is currently active.');
      }
      this.overlays[this.active].container.classList.add('hidden');
      this.overlays[this.active].element.classList.add('hidden');
      this.active = null;

      window.removeEventListener('keydown', this._keyDown);
      resolve();
    }.bind(this));
  },

  /**
   * @private
   */
  _keyDown: function overlayManager_keyDown(evt) {
    var self = OverlayManager;
    if (self.active && evt.keyCode === 27) { // Esc key.
      self._closeThroughCaller();
      evt.preventDefault();
    }
  },

  /**
   * @private
   */
  _closeThroughCaller: function overlayManager_closeThroughCaller() {
    if (this.overlays[this.active].callerCloseMethod) {
      this.overlays[this.active].callerCloseMethod();
    }
    if (this.active) {
      this.close(this.active);
    }
  }
};


var IGNORE_CURRENT_POSITION_ON_ZOOM = false;
var DEFAULT_CACHE_SIZE = 10;


var CLEANUP_TIMEOUT = 30000;

var RenderingStates = {
  INITIAL: 0,
  RUNNING: 1,
  PAUSED: 2,
  FINISHED: 3
};

/**
 * Controls rendering of the views for pages and thumbnails.
 * @class
 */
var PDFRenderingQueue = (function PDFRenderingQueueClosure() {
  /**
   * @constructs
   */
  function PDFRenderingQueue() {
    this.pdfViewer = null;
    this.onIdle = null;

    this.highestPriorityPage = null;
    this.idleTimeout = null;
  }

  PDFRenderingQueue.prototype = /** @lends PDFRenderingQueue.prototype */ {
    /**
     * @param {PDFViewer} pdfViewer
     */
    setViewer: function PDFRenderingQueue_setViewer(pdfViewer) {
      this.pdfViewer = pdfViewer;
    },

    /**
     * @param {IRenderableView} view
     * @returns {boolean}
     */
    isHighestPriority: function PDFRenderingQueue_isHighestPriority(view) {
      return this.highestPriorityPage === view.renderingId;
    },

    renderHighestPriority: function
        PDFRenderingQueue_renderHighestPriority(currentlyVisiblePages) {
      if (this.idleTimeout) {
        clearTimeout(this.idleTimeout);
        this.idleTimeout = null;
      }

      // Pages have a higher priority than thumbnails, so check them first.
      if (this.pdfViewer.forceRendering(currentlyVisiblePages)) {
        return;
      }

      if (this.onIdle) {
        this.idleTimeout = setTimeout(this.onIdle.bind(this), CLEANUP_TIMEOUT);
      }
    },

    getHighestPriority: function
        PDFRenderingQueue_getHighestPriority(visible, views, scrolledDown) {
      // The state has changed figure out which page has the highest priority to
      // render next (if any).
      // Priority:
      // 1 visible pages
      // 2 if last scrolled down page after the visible pages
      // 2 if last scrolled up page before the visible pages
      var visibleViews = visible.views;

      var numVisible = visibleViews.length;
      if (numVisible === 0) {
        return false;
      }
      for (var i = 0; i < numVisible; ++i) {
        var view = visibleViews[i].view;
        if (!this.isViewFinished(view)) {
          return view;
        }
      }

      // All the visible views have rendered, try to render next/previous pages.
      if (scrolledDown) {
        var nextPageIndex = visible.last.id;
        // ID's start at 1 so no need to add 1.
        if (views[nextPageIndex] &&
            !this.isViewFinished(views[nextPageIndex])) {
          return views[nextPageIndex];
        }
      } else {
        var previousPageIndex = visible.first.id - 2;
        if (views[previousPageIndex] &&
          !this.isViewFinished(views[previousPageIndex])) {
          return views[previousPageIndex];
        }
      }
      // Everything that needs to be rendered has been.
      return null;
    },

    /**
     * @param {IRenderableView} view
     * @returns {boolean}
     */
    isViewFinished: function PDFRenderingQueue_isViewFinished(view) {
      return view.renderingState === RenderingStates.FINISHED;
    },

    /**
     * Render a page or thumbnail view. This calls the appropriate function
     * based on the views state. If the view is already rendered it will return
     * false.
     * @param {IRenderableView} view
     */
    renderView: function PDFRenderingQueue_renderView(view) {
      var state = view.renderingState;
      switch (state) {
        case RenderingStates.FINISHED:
          return false;
        case RenderingStates.PAUSED:
          this.highestPriorityPage = view.renderingId;
          view.resume();
          break;
        case RenderingStates.RUNNING:
          this.highestPriorityPage = view.renderingId;
          break;
        case RenderingStates.INITIAL:
          this.highestPriorityPage = view.renderingId;
          var continueRendering = function () {
            this.renderHighestPriority();
          }.bind(this);
          view.draw().then(continueRendering, continueRendering);
          break;
      }
      return true;
    },
  };

  return PDFRenderingQueue;
})();


var TEXT_LAYER_RENDER_DELAY = 200; // ms

/**
 * @typedef {Object} PDFPageViewOptions
 * @property {HTMLDivElement} container - The viewer element.
 * @property {number} id - The page unique ID (normally its number).
 * @property {number} scale - The page scale display.
 * @property {PageViewport} defaultViewport - The page viewport.
 * @property {PDFRenderingQueue} renderingQueue - The rendering queue object.
 * @property {IPDFTextLayerFactory} textLayerFactory
 * @property {IPDFAnnotationsLayerFactory} annotationsLayerFactory
 */

/**
 * @class
 * @implements {IRenderableView}
 */
var PDFPageView = (function PDFPageViewClosure() {
  /**
   * @constructs PDFPageView
   * @param {PDFPageViewOptions} options
   */
  function PDFPageView(options) {
    var container = options.container;
    var id = options.id;
    var scale = options.scale;
    var defaultViewport = options.defaultViewport;
    var renderingQueue = options.renderingQueue;
    var textLayerFactory = options.textLayerFactory;
    var annotationsLayerFactory = options.annotationsLayerFactory;

    this.id = id;
    this.renderingId = 'page' + id;

    this.scale = scale || 1.0;
    this.viewport = defaultViewport;
    this.hasRestrictedScaling = false;

    this.renderingQueue = renderingQueue;
    this.textLayerFactory = textLayerFactory;
    this.annotationsLayerFactory = annotationsLayerFactory;

    this.renderingState = RenderingStates.INITIAL;
    this.resume = null;

    this.onBeforeDraw = null;
    this.onAfterDraw = null;

    this.textLayer = null;

    this.zoomLayer = null;

    this.annotationLayer = null;

    var div = document.createElement('div');
    div.id = 'pageContainer' + this.id;
    div.className = 'page';
    div.style.width = Math.floor(this.viewport.width) + 'px';
    div.style.height = Math.floor(this.viewport.height) + 'px';
    div.setAttribute('data-page-number', this.id);
    this.div = div;

    container.appendChild(div);
  }

  PDFPageView.prototype = {
    setPdfPage: function PDFPageView_setPdfPage(pdfPage) {
      this.pdfPage = pdfPage;
      this.viewport = pdfPage.getViewport(this.scale * CSS_UNITS);
      this.stats = pdfPage.stats;
      this.reset();
    },

    destroy: function PDFPageView_destroy() {
      this.zoomLayer = null;
      this.reset();
      if (this.pdfPage) {
        this.pdfPage.destroy();
      }
    },

    reset: function PDFPageView_reset(keepAnnotations) {
      if (this.renderTask) {
        this.renderTask.cancel();
      }
      this.resume = null;
      this.renderingState = RenderingStates.INITIAL;

      var div = this.div;
      div.style.width = Math.floor(this.viewport.width) + 'px';
      div.style.height = Math.floor(this.viewport.height) + 'px';

      var childNodes = div.childNodes;
      var currentZoomLayer = this.zoomLayer || null;
      var currentAnnotationNode = (keepAnnotations && this.annotationLayer &&
                                   this.annotationLayer.div) || null;
      for (var i = childNodes.length - 1; i >= 0; i--) {
        var node = childNodes[i];
        if (currentZoomLayer === node || currentAnnotationNode === node) {
          continue;
        }
        div.removeChild(node);
      }
      div.removeAttribute('data-loaded');

      if (keepAnnotations) {
        if (this.annotationLayer) {
          // Hide annotationLayer until all elements are resized
          // so they are not displayed on the already-resized page
          this.annotationLayer.hide();
        }
      } else {
        this.annotationLayer = null;
      }

      if (this.canvas) {
        // Zeroing the width and height causes Firefox to release graphics
        // resources immediately, which can greatly reduce memory consumption.
        this.canvas.width = 0;
        this.canvas.height = 0;
        delete this.canvas;
      }

      this.loadingIconDiv = document.createElement('div');
      this.loadingIconDiv.className = 'loadingIcon';
      div.appendChild(this.loadingIconDiv);
    },

    update: function PDFPageView_update(scale) {
      this.scale = scale || this.scale;

      this.viewport = this.viewport.clone({
        scale: this.scale * CSS_UNITS
      });

      var isScalingRestricted = false;
      if (this.canvas && PDFJS.maxCanvasPixels > 0) {
        var ctx = this.canvas.getContext('2d');
        var outputScale = getOutputScale(ctx);
        var pixelsInViewport = this.viewport.width * this.viewport.height;
        var maxScale = Math.sqrt(PDFJS.maxCanvasPixels / pixelsInViewport);
        if (((Math.floor(this.viewport.width) * outputScale.sx) | 0) *
            ((Math.floor(this.viewport.height) * outputScale.sy) | 0) >
            PDFJS.maxCanvasPixels) {
          isScalingRestricted = true;
        }
      }

      if (this.canvas &&
          (PDFJS.useOnlyCssZoom ||
            (this.hasRestrictedScaling && isScalingRestricted))) {
        this.cssTransform(this.canvas, true);
        return;
      } else if (this.canvas && !this.zoomLayer) {
        this.zoomLayer = this.canvas.parentNode;
        this.zoomLayer.style.position = 'absolute';
      }
      if (this.zoomLayer) {
        this.cssTransform(this.zoomLayer.firstChild);
      }
      this.reset(true);
    },

    /**
     * Called when moved in the parent's container.
     */
    updatePosition: function PDFPageView_updatePosition() {
      if (this.textLayer) {
        this.textLayer.render(TEXT_LAYER_RENDER_DELAY);
      }
    },

    cssTransform: function PDFPageView_transform(canvas, redrawAnnotations) {
      // Scale canvas, canvas wrapper, and page container.
      var width = this.viewport.width;
      var height = this.viewport.height;
      var div = this.div;
      canvas.style.width = canvas.parentNode.style.width = div.style.width =
        Math.floor(width) + 'px';
      canvas.style.height = canvas.parentNode.style.height = div.style.height =
        Math.floor(height) + 'px';

      if (this.textLayer) {
        var textLayerDiv = this.textLayer.textLayerDiv;
        CustomStyle.setProp('transformOrigin', textLayerDiv, '0% 0%');
      }

      if (redrawAnnotations && this.annotationLayer) {
        this.annotationLayer.setupAnnotations(this.viewport);
      }
    },

    get width() {
      return this.viewport.width;
    },

    get height() {
      return this.viewport.height;
    },

    getPagePoint: function PDFPageView_getPagePoint(x, y) {
      return this.viewport.convertToPdfPoint(x, y);
    },

    draw: function PDFPageView_draw() {
      if (this.renderingState !== RenderingStates.INITIAL) {
        console.error('Must be in new state before drawing');
      }

      this.renderingState = RenderingStates.RUNNING;

      var pdfPage = this.pdfPage;
      var viewport = this.viewport;
      var div = this.div;
      // Wrap the canvas so if it has a css transform for highdpi the overflow
      // will be hidden in FF.
      var canvasWrapper = document.createElement('div');
      canvasWrapper.style.width = div.style.width;
      canvasWrapper.style.height = div.style.height;
      canvasWrapper.classList.add('canvasWrapper');

      var canvas = document.createElement('canvas');
      canvas.id = 'page' + this.id;
      canvasWrapper.appendChild(canvas);
      if (this.annotationLayer) {
        // annotationLayer needs to stay on top
        div.insertBefore(canvasWrapper, this.annotationLayer.div);
      } else {
        div.appendChild(canvasWrapper);
      }
      this.canvas = canvas;

      var ctx = canvas.getContext('2d');
      var outputScale = getOutputScale(ctx);

      if (PDFJS.useOnlyCssZoom) {
        var actualSizeViewport = viewport.clone({ scale: CSS_UNITS });
        // Use a scale that will make the canvas be the original intended size
        // of the page.
        outputScale.sx *= actualSizeViewport.width / viewport.width;
        outputScale.sy *= actualSizeViewport.height / viewport.height;
        outputScale.scaled = true;
      }

      if (PDFJS.maxCanvasPixels > 0) {
        var pixelsInViewport = viewport.width * viewport.height;
        var maxScale = Math.sqrt(PDFJS.maxCanvasPixels / pixelsInViewport);
        if (outputScale.sx > maxScale || outputScale.sy > maxScale) {
          outputScale.sx = maxScale;
          outputScale.sy = maxScale;
          outputScale.scaled = true;
          this.hasRestrictedScaling = true;
        } else {
          this.hasRestrictedScaling = false;
        }
      }

      canvas.width = (Math.floor(viewport.width) * outputScale.sx) | 0;
      canvas.height = (Math.floor(viewport.height) * outputScale.sy) | 0;
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      // Add the viewport so it's known what it was originally drawn with.
      canvas._viewport = viewport;

      var textLayerDiv = null;
      var textLayer = null;
      if (this.textLayerFactory) {
        textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.width = canvas.style.width;
        textLayerDiv.style.height = canvas.style.height;
        if (this.annotationLayer) {
          // annotationLayer needs to stay on top
          div.insertBefore(textLayerDiv, this.annotationLayer.div);
        } else {
          div.appendChild(textLayerDiv);
        }

        textLayer = this.textLayerFactory.createTextLayerBuilder(textLayerDiv,
                                                                 this.id - 1,
                                                                 this.viewport);
      }
      this.textLayer = textLayer;

      if (outputScale.scaled) {
        // Used by the mozCurrentTransform polyfill in src/display/canvas.js.
        ctx._transformMatrix = [outputScale.sx, 0, 0, outputScale.sy, 0, 0];
        ctx.scale(outputScale.sx, outputScale.sy);
      }

      var resolveRenderPromise, rejectRenderPromise;
      var promise = new Promise(function (resolve, reject) {
        resolveRenderPromise = resolve;
        rejectRenderPromise = reject;
      });

      // Rendering area

      var self = this;
      function pageViewDrawCallback(error) {
        // The renderTask may have been replaced by a new one, so only remove
        // the reference to the renderTask if it matches the one that is
        // triggering this callback.
        if (renderTask === self.renderTask) {
          self.renderTask = null;
        }

        if (error === 'cancelled') {
          rejectRenderPromise(error);
          return;
        }

        self.renderingState = RenderingStates.FINISHED;

        if (self.loadingIconDiv) {
          div.removeChild(self.loadingIconDiv);
          delete self.loadingIconDiv;
        }

        if (self.zoomLayer) {
          div.removeChild(self.zoomLayer);
          self.zoomLayer = null;
        }

        self.error = error;
        self.stats = pdfPage.stats;
        if (self.onAfterDraw) {
          self.onAfterDraw();
        }
        var event = document.createEvent('CustomEvent');
        event.initCustomEvent('pagerendered', true, true, {
          pageNumber: self.id
        });
        div.dispatchEvent(event);
        // This custom event is deprecated, and will be removed in the future,
        // please use the |pagerendered| event instead.
        var deprecatedEvent = document.createEvent('CustomEvent');
        deprecatedEvent.initCustomEvent('pagerender', true, true, {
          pageNumber: pdfPage.pageNumber
        });
        div.dispatchEvent(deprecatedEvent);

        if (!error) {
          resolveRenderPromise(undefined);
        } else {
          rejectRenderPromise(error);
        }
      }

      var renderContinueCallback = null;
      if (this.renderingQueue) {
        renderContinueCallback = function renderContinueCallback(cont) {
          if (!self.renderingQueue.isHighestPriority(self)) {
            self.renderingState = RenderingStates.PAUSED;
            self.resume = function resumeCallback() {
              self.renderingState = RenderingStates.RUNNING;
              cont();
            };
            return;
          }
          cont();
        };
      }

      var renderContext = {
        canvasContext: ctx,
        viewport: this.viewport,
        // intent: 'default', // === 'display'
        continueCallback: renderContinueCallback
      };
      var renderTask = this.renderTask = this.pdfPage.render(renderContext);

      this.renderTask.promise.then(
        function pdfPageRenderCallback() {
          pageViewDrawCallback(null);
          if (textLayer) {
            self.pdfPage.getTextContent().then(
              function textContentResolved(textContent) {
                textLayer.setTextContent(textContent);
                textLayer.render(TEXT_LAYER_RENDER_DELAY);
              }
            );
          }
        },
        function pdfPageRenderError(error) {
          pageViewDrawCallback(error);
        }
      );

      if (this.annotationsLayerFactory) {
        if (!this.annotationLayer) {
          this.annotationLayer = this.annotationsLayerFactory.
            createAnnotationsLayerBuilder(div, this.pdfPage);
        }
        this.annotationLayer.setupAnnotations(this.viewport);
      }
      div.setAttribute('data-loaded', true);

      if (self.onBeforeDraw) {
        self.onBeforeDraw();
      }
      return promise;
    }
  };

  return PDFPageView;
})();


var MAX_TEXT_DIVS_TO_RENDER = 100000;

var NonWhitespaceRegexp = /\S/;

function isAllWhitespace(str) {
  return !NonWhitespaceRegexp.test(str);
}

/**
 * @typedef {Object} TextLayerBuilderOptions
 * @property {HTMLDivElement} textLayerDiv - The text layer container.
 * @property {number} pageIndex - The page index.
 * @property {PageViewport} viewport - The viewport of the text layer.
 */

/**
 * TextLayerBuilder provides text-selection functionality for the PDF.
 * It does this by creating overlay divs over the PDF text. These divs
 * contain text that matches the PDF text they are overlaying. This object
 * also provides a way to highlight text that is being searched for.
 * @class
 */
var TextLayerBuilder = (function TextLayerBuilderClosure() {
  function TextLayerBuilder(options) {
    this.textLayerDiv = options.textLayerDiv;
    this.renderingDone = false;
    this.divContentDone = false;
    this.pageIdx = options.pageIndex;
    this.pageNumber = this.pageIdx + 1;
    this.matches = [];
    this.viewport = options.viewport;
    this.textDivs = [];
  }

  TextLayerBuilder.prototype = {
    _finishRendering: function TextLayerBuilder_finishRendering() {
      this.renderingDone = true;

      var event = document.createEvent('CustomEvent');
      event.initCustomEvent('textlayerrendered', true, true, {
        pageNumber: this.pageNumber
      });
      this.textLayerDiv.dispatchEvent(event);
    },

    renderLayer: function TextLayerBuilder_renderLayer() {
      var textLayerFrag = document.createDocumentFragment();
      var textDivs = this.textDivs;
      var textDivsLength = textDivs.length;
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');

      // No point in rendering many divs as it would make the browser
      // unusable even after the divs are rendered.
      if (textDivsLength > MAX_TEXT_DIVS_TO_RENDER) {
        this._finishRendering();
        return;
      }

      var lastFontSize;
      var lastFontFamily;
      for (var i = 0; i < textDivsLength; i++) {
        var textDiv = textDivs[i];
        if (textDiv.dataset.isWhitespace !== undefined) {
          continue;
        }

        var fontSize = textDiv.style.fontSize;
        var fontFamily = textDiv.style.fontFamily;

        // Only build font string and set to context if different from last.
        if (fontSize !== lastFontSize || fontFamily !== lastFontFamily) {
          ctx.font = fontSize + ' ' + fontFamily;
          lastFontSize = fontSize;
          lastFontFamily = fontFamily;
        }

        var width = ctx.measureText(textDiv.textContent).width;
        if (width > 0) {
          textLayerFrag.appendChild(textDiv);
          var transform;
          if (textDiv.dataset.canvasWidth !== undefined) {
            // Dataset values come of type string.
            var textScale = textDiv.dataset.canvasWidth / width;
            transform = 'scaleX(' + textScale + ')';
          } else {
            transform = '';
          }
          if (transform) {
            CustomStyle.setProp('transform' , textDiv, transform);
          }
        }
      }

      this.textLayerDiv.appendChild(textLayerFrag);
      this._finishRendering();
      this.updateMatches();
    },

    /**
     * Renders the text layer.
     * @param {number} timeout (optional) if specified, the rendering waits
     *   for specified amount of ms.
     */
    render: function TextLayerBuilder_render(timeout) {
      if (!this.divContentDone || this.renderingDone) {
        return;
      }

      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }

      if (!timeout) { // Render right away
        this.renderLayer();
      } else { // Schedule
        var self = this;
        this.renderTimer = setTimeout(function() {
          self.renderLayer();
          self.renderTimer = null;
        }, timeout);
      }
    },

    appendText: function TextLayerBuilder_appendText(geom, styles) {
      var style = styles[geom.fontName];
      var textDiv = document.createElement('div');
      this.textDivs.push(textDiv);
      if (isAllWhitespace(geom.str)) {
        textDiv.dataset.isWhitespace = true;
        return;
      }
      var tx = PDFJS.Util.transform(this.viewport.transform, geom.transform);
      var angle = Math.atan2(tx[1], tx[0]);
      if (style.vertical) {
        angle += Math.PI / 2;
      }
      var fontHeight = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
      var fontAscent = fontHeight;
      if (style.ascent) {
        fontAscent = style.ascent * fontAscent;
      } else if (style.descent) {
        fontAscent = (1 + style.descent) * fontAscent;
      }

      var left;
      var top;
      if (angle === 0) {
        left = tx[4];
        top = tx[5] - fontAscent;
      } else {
        left = tx[4] + (fontAscent * Math.sin(angle));
        top = tx[5] - (fontAscent * Math.cos(angle));
      }
      textDiv.style.left = left + 'px';
      textDiv.style.top = top + 'px';
      textDiv.style.fontSize = fontHeight + 'px';
      textDiv.style.fontFamily = style.fontFamily;

      textDiv.textContent = geom.str;
      // |fontName| is only used by the Font Inspector. This test will succeed
      // when e.g. the Font Inspector is off but the Stepper is on, but it's
      // not worth the effort to do a more accurate test.
      if (PDFJS.pdfBug) {
        textDiv.dataset.fontName = geom.fontName;
      }
      // Storing into dataset will convert number into string.
      if (angle !== 0) {
        textDiv.dataset.angle = angle * (180 / Math.PI);
      }
      // We don't bother scaling single-char text divs, because it has very
      // little effect on text highlighting. This makes scrolling on docs with
      // lots of such divs a lot faster.
      if (geom.str.length > 1) {
        if (style.vertical) {
          textDiv.dataset.canvasWidth = geom.height * this.viewport.scale;
        } else {
          textDiv.dataset.canvasWidth = geom.width * this.viewport.scale;
        }
      }
    },

    setTextContent: function TextLayerBuilder_setTextContent(textContent) {
      this.textContent = textContent;

      var textItems = textContent.items;
      for (var i = 0, len = textItems.length; i < len; i++) {
        this.appendText(textItems[i], textContent.styles);
      }
      this.divContentDone = true;
    },

    convertMatches: function TextLayerBuilder_convertMatches(matches) {
      var i = 0;
      var iIndex = 0;
      var bidiTexts = this.textContent.items;
      var end = bidiTexts.length - 1;
      var queryLen = 0;
      var ret = [];

      for (var m = 0, len = matches.length; m < len; m++) {
        // Calculate the start position.
        var matchIdx = matches[m];

        // Loop over the divIdxs.
        while (i !== end && matchIdx >= (iIndex + bidiTexts[i].str.length)) {
          iIndex += bidiTexts[i].str.length;
          i++;
        }

        if (i === bidiTexts.length) {
          console.error('Could not find a matching mapping');
        }

        var match = {
          begin: {
            divIdx: i,
            offset: matchIdx - iIndex
          }
        };

        // Calculate the end position.
        matchIdx += queryLen;

        // Somewhat the same array as above, but use > instead of >= to get
        // the end position right.
        while (i !== end && matchIdx > (iIndex + bidiTexts[i].str.length)) {
          iIndex += bidiTexts[i].str.length;
          i++;
        }

        match.end = {
          divIdx: i,
          offset: matchIdx - iIndex
        };
        ret.push(match);
      }

      return ret;
    },

    renderMatches: function TextLayerBuilder_renderMatches(matches) {
      // Early exit if there is nothing to render.
      if (matches.length === 0) {
        return;
      }

      var bidiTexts = this.textContent.items;
      var textDivs = this.textDivs;
      var prevEnd = null;
      var pageIdx = this.pageIdx;
      var isSelectedPage = false;
      var selectedMatchIdx = -1;
      var highlightAll = false;
      var infinity = {
        divIdx: -1,
        offset: undefined
      };

      function beginText(begin, className) {
        var divIdx = begin.divIdx;
        textDivs[divIdx].textContent = '';
        appendTextToDiv(divIdx, 0, begin.offset, className);
      }

      function appendTextToDiv(divIdx, fromOffset, toOffset, className) {
        var div = textDivs[divIdx];
        var content = bidiTexts[divIdx].str.substring(fromOffset, toOffset);
        var node = document.createTextNode(content);
        if (className) {
          var span = document.createElement('span');
          span.className = className;
          span.appendChild(node);
          div.appendChild(span);
          return;
        }
        div.appendChild(node);
      }

      var i0 = selectedMatchIdx, i1 = i0 + 1;
      if (highlightAll) {
        i0 = 0;
        i1 = matches.length;
      } else if (!isSelectedPage) {
        // Not highlighting all and this isn't the selected page, so do nothing.
        return;
      }

      for (var i = i0; i < i1; i++) {
        var match = matches[i];
        var begin = match.begin;
        var end = match.end;
        var isSelected = (isSelectedPage && i === selectedMatchIdx);
        var highlightSuffix = (isSelected ? ' selected' : '');

        // Match inside new div.
        if (!prevEnd || begin.divIdx !== prevEnd.divIdx) {
          // If there was a previous div, then add the text at the end.
          if (prevEnd !== null) {
            appendTextToDiv(prevEnd.divIdx, prevEnd.offset, infinity.offset);
          }
          // Clear the divs and set the content until the starting point.
          beginText(begin);
        } else {
          appendTextToDiv(prevEnd.divIdx, prevEnd.offset, begin.offset);
        }

        if (begin.divIdx === end.divIdx) {
          appendTextToDiv(begin.divIdx, begin.offset, end.offset,
                          'highlight' + highlightSuffix);
        } else {
          appendTextToDiv(begin.divIdx, begin.offset, infinity.offset,
                          'highlight begin' + highlightSuffix);
          for (var n0 = begin.divIdx + 1, n1 = end.divIdx; n0 < n1; n0++) {
            textDivs[n0].className = 'highlight middle' + highlightSuffix;
          }
          beginText(end, 'highlight end' + highlightSuffix);
        }
        prevEnd = end;
      }

      if (prevEnd) {
        appendTextToDiv(prevEnd.divIdx, prevEnd.offset, infinity.offset);
      }
    },

    updateMatches: function TextLayerBuilder_updateMatches() {
      // Only show matches when all rendering is done.
      if (!this.renderingDone) {
        return;
      }

      // Clear all matches.
      var matches = this.matches;
      var textDivs = this.textDivs;
      var bidiTexts = this.textContent.items;
      var clearedUntilDivIdx = -1;

      // Clear all current matches.
      for (var i = 0, len = matches.length; i < len; i++) {
        var match = matches[i];
        var begin = Math.max(clearedUntilDivIdx, match.begin.divIdx);
        for (var n = begin, end = match.end.divIdx; n <= end; n++) {
          var div = textDivs[n];
          div.textContent = bidiTexts[n].str;
          div.className = '';
        }
        clearedUntilDivIdx = match.end.divIdx + 1;
      }

      return;

    }
  };
  return TextLayerBuilder;
})();

/**
 * @constructor
 * @implements IPDFTextLayerFactory
 */
function DefaultTextLayerFactory() {}
DefaultTextLayerFactory.prototype = {
  /**
   * @param {HTMLDivElement} textLayerDiv
   * @param {number} pageIndex
   * @param {PageViewport} viewport
   * @returns {TextLayerBuilder}
   */
  createTextLayerBuilder: function (textLayerDiv, pageIndex, viewport) {
    return new TextLayerBuilder({
      textLayerDiv: textLayerDiv,
      pageIndex: pageIndex,
      viewport: viewport
    });
  }
};


/**
 * @typedef {Object} AnnotationsLayerBuilderOptions
 * @property {HTMLDivElement} pageDiv
 * @property {PDFPage} pdfPage
 * @property {IPDFLinkService} linkService
 */

/**
 * @class
 */
var AnnotationsLayerBuilder = (function AnnotationsLayerBuilderClosure() {
  /**
   * @param {AnnotationsLayerBuilderOptions} options
   * @constructs AnnotationsLayerBuilder
   */
  function AnnotationsLayerBuilder(options) {
    this.pageDiv = options.pageDiv;
    this.pdfPage = options.pdfPage;
    this.linkService = options.linkService;

    this.div = null;
  }
  AnnotationsLayerBuilder.prototype =
      /** @lends AnnotationsLayerBuilder.prototype */ {

    /**
     * @param {PageViewport} viewport
     */
    setupAnnotations:
        function AnnotationsLayerBuilder_setupAnnotations(viewport) {
      function bindLink(link, dest) {
        link.href = linkService.getDestinationHash(dest);
        link.onclick = function annotationsLayerBuilderLinksOnclick() {
          if (dest) {
            linkService.navigateTo(dest);
          }
          return false;
        };
        if (dest) {
          link.className = 'internalLink';
        }
      }

      function bindNamedAction(link, action) {
        link.href = linkService.getAnchorUrl('');
        link.onclick = function annotationsLayerBuilderNamedActionOnClick() {
          linkService.executeNamedAction(action);
          return false;
        };
        link.className = 'internalLink';
      }

      var linkService = this.linkService;
      var pdfPage = this.pdfPage;
      var self = this;

      pdfPage.getAnnotations().then(function (annotationsData) {
        viewport = viewport.clone({ dontFlip: true });
        var transform = viewport.transform;
        var transformStr = 'matrix(' + transform.join(',') + ')';
        var data, element, i, ii;

        if (self.div) {
          // If an annotationLayer already exists, refresh its children's
          // transformation matrices
          for (i = 0, ii = annotationsData.length; i < ii; i++) {
            data = annotationsData[i];
            element = self.div.querySelector(
                '[data-annotation-id="' + data.id + '"]');
            if (element) {
              CustomStyle.setProp('transform', element, transformStr);
            }
          }
          // See PDFPageView.reset()
          self.div.removeAttribute('hidden');
        } else {
          for (i = 0, ii = annotationsData.length; i < ii; i++) {
            data = annotationsData[i];
            if (!data || !data.hasHtml) {
              continue;
            }

            element = PDFJS.AnnotationUtils.getHtmlElement(data,
              pdfPage.commonObjs);
            element.setAttribute('data-annotation-id', data.id);
            if (typeof mozL10n !== 'undefined') {
              mozL10n.translate(element);
            }

            var rect = data.rect;
            var view = pdfPage.view;
            rect = PDFJS.Util.normalizeRect([
              rect[0],
                view[3] - rect[1] + view[1],
              rect[2],
                view[3] - rect[3] + view[1]
            ]);
            element.style.left = rect[0] + 'px';
            element.style.top = rect[1] + 'px';
            element.style.position = 'absolute';

            CustomStyle.setProp('transform', element, transformStr);
            var transformOriginStr = -rect[0] + 'px ' + -rect[1] + 'px';
            CustomStyle.setProp('transformOrigin', element, transformOriginStr);

            if (data.subtype === 'Link' && !data.url) {
              var link = element.getElementsByTagName('a')[0];
              if (link) {
                if (data.action) {
                  bindNamedAction(link, data.action);
                } else {
                  bindLink(link, ('dest' in data) ? data.dest : null);
                }
              }
            }

            if (!self.div) {
              var annotationLayerDiv = document.createElement('div');
              annotationLayerDiv.className = 'annotationLayer';
              self.pageDiv.appendChild(annotationLayerDiv);
              self.div = annotationLayerDiv;
            }

            self.div.appendChild(element);
          }
        }
      });
    },

    hide: function () {
      if (!this.div) {
        return;
      }
      this.div.setAttribute('hidden', 'true');
    }
  };
  return AnnotationsLayerBuilder;
})();

/**
 * @constructor
 * @implements IPDFAnnotationsLayerFactory
 */
function DefaultAnnotationsLayerFactory() {}
DefaultAnnotationsLayerFactory.prototype = {
  /**
   * @param {HTMLDivElement} pageDiv
   * @param {PDFPage} pdfPage
   * @returns {AnnotationsLayerBuilder}
   */
  createAnnotationsLayerBuilder: function (pageDiv, pdfPage) {
    return new AnnotationsLayerBuilder({
      pageDiv: pageDiv,
      pdfPage: pdfPage,
      linkService: new SimpleLinkService(),
    });
  }
};


/**
 * @typedef {Object} PDFViewerOptions
 * @property {HTMLDivElement} container - The container for the viewer element.
 * @property {HTMLDivElement} viewer - (optional) The viewer element.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 * @property {PDFRenderingQueue} renderingQueue - (optional) The rendering
 *   queue object.
 * @property {boolean} removePageBorders - (optional) Removes the border shadow
 *   around the pages. The default is false.
 */

/**
 * Simple viewer control to display PDF content/pages.
 * @class
 * @implements {IRenderableView}
 */
var PDFViewer = (function pdfViewer() {
  function PDFPageViewBuffer(size) {
    var data = [];
    this.push = function cachePush(view) {
      var i = data.indexOf(view);
      if (i >= 0) {
        data.splice(i, 1);
      }
      data.push(view);
      if (data.length > size) {
        data.shift().destroy();
      }
    };
    this.resize = function (newSize) {
      size = newSize;
      while (data.length > size) {
        data.shift().destroy();
      }
    };
  }

  function isSameScale(oldScale, newScale) {
    if (newScale === oldScale) {
      return true;
    }
    if (Math.abs(newScale - oldScale) < 1e-15) {
      // Prevent unnecessary re-rendering of all pages when the scale
      // changes only because of limited numerical precision.
      return true;
    }
    return false;
  }

  /**
   * @constructs PDFViewer
   * @param {PDFViewerOptions} options
   */
  function PDFViewer(options) {
    this.container = options.container;
    this.viewer = options.viewer || options.container.firstElementChild;
    this.linkService = options.linkService || new SimpleLinkService();
    this.removePageBorders = options.removePageBorders || false;

    this.defaultRenderingQueue = !options.renderingQueue;
    if (this.defaultRenderingQueue) {
      // Custom rendering queue is not specified, using default one
      this.renderingQueue = new PDFRenderingQueue();
      this.renderingQueue.setViewer(this);
    } else {
      this.renderingQueue = options.renderingQueue;
    }

    this.scroll = watchScroll(this.container, this._scrollUpdate.bind(this));
    this.updateInProgress = false;
    this._resetView();

    if (this.removePageBorders) {
      this.viewer.classList.add('removePageBorders');
    }
  }

  PDFViewer.prototype = /** @lends PDFViewer.prototype */{
    get pagesCount() {
      return this._pages.length;
    },

    getPageView: function (index) {
      return this._pages[index];
    },

    get currentPageNumber() {
      return this._currentPageNumber;
    },

    set currentPageNumber(val) {
      if (!this.pdfDocument) {
        this._currentPageNumber = val;
        return;
      }

      var event = document.createEvent('UIEvents');
      event.initUIEvent('pagechange', true, true, window, 0);
      event.updateInProgress = this.updateInProgress;

      if (!(0 < val && val <= this.pagesCount)) {
        event.pageNumber = this._currentPageNumber;
        event.previousPageNumber = val;
        this.container.dispatchEvent(event);
        return;
      }

      event.previousPageNumber = this._currentPageNumber;
      this._currentPageNumber = val;
      event.pageNumber = val;
      this.container.dispatchEvent(event);

      // Check if the caller is `PDFViewer_update`, to avoid breaking scrolling.
      if (this.updateInProgress) {
        return;
      }
      this.scrollPageIntoView(val);
    },

    /**
     * @returns {number}
     */
    get currentScale() {
      return this._currentScale !== UNKNOWN_SCALE ? this._currentScale :
                                                    DEFAULT_SCALE;
    },

    /**
     * @param {number} val - Scale of the pages in percents.
     */
    set currentScale(val) {
      if (isNaN(val))  {
        throw new Error('Invalid numeric scale');
      }
      if (!this.pdfDocument) {
        this._currentScale = val;
        this._currentScaleValue = val !== UNKNOWN_SCALE ? val.toString() : null;
        return;
      }
      this._setScale(val, false);
    },

    /**
     * @returns {string}
     */
    get currentScaleValue() {
      return this._currentScaleValue;
    },

    /**
     * @param val - The scale of the pages (in percent or predefined value).
     */
    set currentScaleValue(val) {
      if (!this.pdfDocument) {
        this._currentScale = isNaN(val) ? UNKNOWN_SCALE : val;
        this._currentScaleValue = val;
        return;
      }
      this._setScale(val, false);
    },

    /**
     * @param pdfDocument {PDFDocument}
     */
    setDocument: function (pdfDocument) {
      if (this.pdfDocument) {
        this._resetView();
      }

      this.pdfDocument = pdfDocument;
      if (!pdfDocument) {
        return;
      }

      var pagesCount = pdfDocument.numPages;
      var self = this;

      var resolvePagesPromise;
      var pagesPromise = new Promise(function (resolve) {
        resolvePagesPromise = resolve;
      });
      this.pagesPromise = pagesPromise;
      pagesPromise.then(function () {
        var event = document.createEvent('CustomEvent');
        event.initCustomEvent('pagesloaded', true, true, {
          pagesCount: pagesCount
        });
        self.container.dispatchEvent(event);
      });

      var isOnePageRenderedResolved = false;
      var resolveOnePageRendered = null;
      var onePageRendered = new Promise(function (resolve) {
        resolveOnePageRendered = resolve;
      });
      this.onePageRendered = onePageRendered;

      var bindOnAfterAndBeforeDraw = function (pageView) {
        pageView.onBeforeDraw = function pdfViewLoadOnBeforeDraw() {
          // Add the page to the buffer at the start of drawing. That way it can
          // be evicted from the buffer and destroyed even if we pause its
          // rendering.
          self._buffer.push(this);
        };
        // when page is painted, using the image as thumbnail base
        pageView.onAfterDraw = function pdfViewLoadOnAfterDraw() {
          if (!isOnePageRenderedResolved) {
            isOnePageRenderedResolved = true;
            resolveOnePageRendered();
          }
        };
      };

      var firstPagePromise = pdfDocument.getPage(1);
      this.firstPagePromise = firstPagePromise;

      // Fetch a single page so we can get a viewport that will be the default
      // viewport for all pages
      return firstPagePromise.then(function(pdfPage) {
        var scale = this.currentScale;
        var viewport = pdfPage.getViewport(scale * CSS_UNITS);
        for (var pageNum = 1; pageNum <= pagesCount; ++pageNum) {
          var textLayerFactory = null;
          if (!PDFJS.disableTextLayer) {
            textLayerFactory = this;
          }
          var pageView = new PDFPageView({
            container: this.viewer,
            id: pageNum,
            scale: scale,
            defaultViewport: viewport.clone(),
            renderingQueue: this.renderingQueue,
            textLayerFactory: textLayerFactory,
            annotationsLayerFactory: this
          });
          bindOnAfterAndBeforeDraw(pageView);
          this._pages.push(pageView);
        }

        var linkService = this.linkService;

        // Fetch all the pages since the viewport is needed before printing
        // starts to create the correct size canvas. Wait until one page is
        // rendered so we don't tie up too many resources early on.
        onePageRendered.then(function () {
          if (!PDFJS.disableAutoFetch) {
            var getPagesLeft = pagesCount;
            for (var pageNum = 1; pageNum <= pagesCount; ++pageNum) {
              pdfDocument.getPage(pageNum).then(function (pageNum, pdfPage) {
                var pageView = self._pages[pageNum - 1];
                if (!pageView.pdfPage) {
                  pageView.setPdfPage(pdfPage);
                }
                linkService.cachePageRef(pageNum, pdfPage.ref);
                getPagesLeft--;
                if (!getPagesLeft) {
                  resolvePagesPromise();
                }
              }.bind(null, pageNum));
            }
          } else {
            // XXX: Printing is semi-broken with auto fetch disabled.
            resolvePagesPromise();
          }
        });

        var event = document.createEvent('CustomEvent');
        event.initCustomEvent('pagesinit', true, true, null);
        self.container.dispatchEvent(event);

        if (this.defaultRenderingQueue) {
          this.update();
        }

      }.bind(this));
    },

    _resetView: function () {
      this._pages = [];
      this._currentPageNumber = 1;
      this._currentScale = UNKNOWN_SCALE;
      this._currentScaleValue = null;
      this._buffer = new PDFPageViewBuffer(DEFAULT_CACHE_SIZE);
      this._location = null;
      this._pagesRequests = [];

      var container = this.viewer;
      while (container.hasChildNodes()) {
        container.removeChild(container.lastChild);
      }
    },

    _scrollUpdate: function PDFViewer_scrollUpdate() {
      if (this.pagesCount === 0) {
        return;
      }
      this.update();
      for (var i = 0, ii = this._pages.length; i < ii; i++) {
        this._pages[i].updatePosition();
      }
    },

    _setScaleDispatchEvent: function pdfViewer_setScaleDispatchEvent(
        newScale, newValue, preset) {
      var event = document.createEvent('UIEvents');
      event.initUIEvent('scalechange', true, true, window, 0);
      event.scale = newScale;
      if (preset) {
        event.presetValue = newValue;
      }
      this.container.dispatchEvent(event);
    },

    _setScaleUpdatePages: function pdfViewer_setScaleUpdatePages(
        newScale, newValue, noScroll, preset) {
      this._currentScaleValue = newValue;

      if (isSameScale(this._currentScale, newScale)) {
        if (preset) {
          this._setScaleDispatchEvent(newScale, newValue, true);
        }
        return;
      }

      for (var i = 0, ii = this._pages.length; i < ii; i++) {
        this._pages[i].update(newScale);
      }
      this._currentScale = newScale;

      if (!noScroll) {
        var page = this._currentPageNumber, dest;
        if (this._location && !IGNORE_CURRENT_POSITION_ON_ZOOM) {
          page = this._location.pageNumber;
          dest = [null, { name: 'XYZ' }, this._location.left,
                  this._location.top, null];
        }
        this.scrollPageIntoView(page, dest);
      }

      this._setScaleDispatchEvent(newScale, newValue, preset);

      if (this.defaultRenderingQueue) {
        this.update();
      }
    },

    _setScale: function pdfViewer_setScale(value, noScroll) {
      var scale = parseFloat(value);

      if (scale > 0) {
        this._setScaleUpdatePages(scale, value, noScroll, false);
      } else {
        var currentPage = this._pages[this._currentPageNumber - 1];
        if (!currentPage) {
          return;
        }
        var hPadding = (this.removePageBorders) ?
          0 : SCROLLBAR_PADDING;
        var vPadding = (this.removePageBorders) ?
          0 : VERTICAL_PADDING;
        var pageWidthScale = (this.container.clientWidth - hPadding) /
                             currentPage.width * currentPage.scale;
        var pageHeightScale = (this.container.clientHeight - vPadding) /
                              currentPage.height * currentPage.scale;
        switch (value) {
          case 'page-actual':
            scale = 1;
            break;
          case 'page-width':
            scale = pageWidthScale;
            break;
          case 'page-height':
            scale = pageHeightScale;
            break;
          case 'page-fit':
            scale = Math.min(pageWidthScale, pageHeightScale);
            break;
          case 'auto':
            var isLandscape = (currentPage.width > currentPage.height);
            // For pages in landscape mode, fit the page height to the viewer
            // *unless* the page would thus become too wide to fit horizontally.
            var horizontalScale = isLandscape ?
              Math.min(pageHeightScale, pageWidthScale) : pageWidthScale;
            scale = Math.min(MAX_AUTO_SCALE, horizontalScale);
            break;
          default:
            console.error('pdfViewSetScale: \'' + value +
              '\' is an unknown zoom value.');
            return;
        }
        this._setScaleUpdatePages(scale, value, noScroll, true);
      }
    },

    /**
     * Scrolls page into view.
     * @param {number} pageNumber
     * @param {Array} dest - (optional) original PDF destination array:
     *   <page-ref> </XYZ|FitXXX> <args..>
     */
    scrollPageIntoView: function PDFViewer_scrollPageIntoView(pageNumber,
                                                              dest) {
      var pageView = this._pages[pageNumber - 1];

      if (!dest) {
        scrollIntoView(pageView.div);
        return;
      }

      var x = 0, y = 0;
      var width = 0, height = 0, widthScale, heightScale;
      var scale = 0;
      switch (dest[1].name) {
        case 'XYZ':
          x = dest[2];
          y = dest[3];
          scale = dest[4];
          // If x and/or y coordinates are not supplied, default to
          // _top_ left of the page (not the obvious bottom left,
          // since aligning the bottom of the intended page with the
          // top of the window is rarely helpful).
          x = x !== null ? x : 0;
          y = y !== null ? y : pageHeight;
          break;
        case 'Fit':
        case 'FitB':
          scale = 'page-fit';
          break;
        case 'FitH':
        case 'FitBH':
          y = dest[2];
          scale = 'page-width';
          break;
        case 'FitV':
        case 'FitBV':
          x = dest[2];
          width = pageWidth;
          height = pageHeight;
          scale = 'page-height';
          break;
        case 'FitR':
          x = dest[2];
          y = dest[3];
          width = dest[4] - x;
          height = dest[5] - y;
          var hPadding = this.removePageBorders ? 0 : SCROLLBAR_PADDING;
          var vPadding = this.removePageBorders ? 0 : VERTICAL_PADDING;

          widthScale = (this.container.clientWidth - hPadding) /
            width / CSS_UNITS;
          heightScale = (this.container.clientHeight - vPadding) /
            height / CSS_UNITS;
          scale = Math.min(Math.abs(widthScale), Math.abs(heightScale));
          break;
        default:
          return;
      }

      if (scale && scale !== this._currentScale) {
        this.currentScaleValue = scale;
      } else if (this._currentScale === UNKNOWN_SCALE) {
        this.currentScaleValue = DEFAULT_SCALE_VALUE;
      }

      if (scale === 'page-fit' && !dest[4]) {
        scrollIntoView(pageView.div);
        return;
      }

      var boundingRect = [
        pageView.viewport.convertToViewportPoint(x, y),
        pageView.viewport.convertToViewportPoint(x + width, y + height)
      ];
      var left = Math.min(boundingRect[0][0], boundingRect[1][0]);
      var top = Math.min(boundingRect[0][1], boundingRect[1][1]);

      scrollIntoView(pageView.div, { left: left, top: top });
    },

    _updateLocation: function (firstPage) {
      var currentScale = this._currentScale;
      var currentScaleValue = this._currentScaleValue;
      var normalizedScaleValue =
        parseFloat(currentScaleValue) === currentScale ?
        Math.round(currentScale * 10000) / 100 : currentScaleValue;

      var pageNumber = firstPage.id;
      var pdfOpenParams = '#page=' + pageNumber;
      pdfOpenParams += '&zoom=' + normalizedScaleValue;
      var currentPageView = this._pages[pageNumber - 1];
      var container = this.container;
      var topLeft = currentPageView.getPagePoint(
        (container.scrollLeft - firstPage.x),
        (container.scrollTop - firstPage.y));
      var intLeft = Math.round(topLeft[0]);
      var intTop = Math.round(topLeft[1]);
      pdfOpenParams += ',' + intLeft + ',' + intTop;

      this._location = {
        pageNumber: pageNumber,
        scale: normalizedScaleValue,
        top: intTop,
        left: intLeft,
        pdfOpenParams: pdfOpenParams
      };
    },

    update: function PDFViewer_update() {
      var visible = this._getVisiblePages();
      var visiblePages = visible.views;
      if (visiblePages.length === 0) {
        return;
      }

      this.updateInProgress = true;

      var suggestedCacheSize = Math.max(DEFAULT_CACHE_SIZE,
          2 * visiblePages.length + 1);
      this._buffer.resize(suggestedCacheSize);

      this.renderingQueue.renderHighestPriority(visible);

      var currentId = this._currentPageNumber;
      var firstPage = visible.first;

      for (var i = 0, ii = visiblePages.length, stillFullyVisible = false;
           i < ii; ++i) {
        var page = visiblePages[i];

        if (page.percent < 100) {
          break;
        }
        if (page.id === currentId) {
          stillFullyVisible = true;
          break;
        }
      }

      if (!stillFullyVisible) {
        currentId = visiblePages[0].id;
      }

      this.currentPageNumber = currentId;

      this._updateLocation(firstPage);

      this.updateInProgress = false;

      var event = document.createEvent('UIEvents');
      event.initUIEvent('updateviewarea', true, true, window, 0);
      event.location = this._location;
      this.container.dispatchEvent(event);
    },

    containsElement: function (element) {
      return this.container.contains(element);
    },

    focus: function () {
      this.container.focus();
    },

    get isHorizontalScrollbarEnabled() {
      return ((this.container.scrollWidth > this.container.clientWidth));
    },

    _getVisiblePages: function () {
        return getVisibleElements(this.container, this._pages, true);
    },

    cleanup: function () {
      for (var i = 0, ii = this._pages.length; i < ii; i++) {
        if (this._pages[i] &&
            this._pages[i].renderingState !== RenderingStates.FINISHED) {
          this._pages[i].reset();
        }
      }
    },

    /**
     * @param {PDFPageView} pageView
     * @returns {PDFPage}
     * @private
     */
    _ensurePdfPageLoaded: function (pageView) {
      if (pageView.pdfPage) {
        return Promise.resolve(pageView.pdfPage);
      }
      var pageNumber = pageView.id;
      if (this._pagesRequests[pageNumber]) {
        return this._pagesRequests[pageNumber];
      }
      var promise = this.pdfDocument.getPage(pageNumber).then(
          function (pdfPage) {
        pageView.setPdfPage(pdfPage);
        this._pagesRequests[pageNumber] = null;
        return pdfPage;
      }.bind(this));
      this._pagesRequests[pageNumber] = promise;
      return promise;
    },

    forceRendering: function (currentlyVisiblePages) {
      var visiblePages = currentlyVisiblePages || this._getVisiblePages();
      var pageView = this.renderingQueue.getHighestPriority(visiblePages,
                                                            this._pages,
                                                            this.scroll.down);
      if (pageView) {
        this._ensurePdfPageLoaded(pageView).then(function () {
          this.renderingQueue.renderView(pageView);
        }.bind(this));
        return true;
      }
      return false;
    },

    getPageTextContent: function (pageIndex) {
      return this.pdfDocument.getPage(pageIndex + 1).then(function (page) {
        return page.getTextContent();
      });
    },

    /**
     * @param {HTMLDivElement} textLayerDiv
     * @param {number} pageIndex
     * @param {PageViewport} viewport
     * @returns {TextLayerBuilder}
     */
    createTextLayerBuilder: function (textLayerDiv, pageIndex, viewport) {
      return new TextLayerBuilder({
        textLayerDiv: textLayerDiv,
        pageIndex: pageIndex,
        viewport: viewport
      });
    },

    /**
     * @param {HTMLDivElement} pageDiv
     * @param {PDFPage} pdfPage
     * @returns {AnnotationsLayerBuilder}
     */
    createAnnotationsLayerBuilder: function (pageDiv, pdfPage) {
      return new AnnotationsLayerBuilder({
        pageDiv: pageDiv,
        pdfPage: pdfPage,
        linkService: this.linkService
      });
    }
    
  };

  return PDFViewer;
})();

var SimpleLinkService = (function SimpleLinkServiceClosure() {
  function SimpleLinkService() {}

  SimpleLinkService.prototype = {
    /**
     * @returns {number}
     */
    get page() {
      return 0;
    },
    /**
     * @param {number} value
     */
    set page(value) {},
    /**
     * @param dest - The PDF destination object.
     */
    navigateTo: function (dest) {},
    /**
     * @param dest - The PDF destination object.
     * @returns {string} The hyperlink to the PDF object.
     */
    getDestinationHash: function (dest) {
      return '#';
    },
    /**
     * @param hash - The PDF parameters/hash.
     * @returns {string} The hyperlink to the PDF object.
     */
    getAnchorUrl: function (hash) {
      return '#';
    },
    /**
     * @param {string} hash
     */
    setHash: function (hash) {},
    /**
     * @param {string} action
     */
    executeNamedAction: function (action) {},
    /**
     * @param {number} pageNum - page number.
     * @param {Object} pageRef - reference to the page.
     */
    cachePageRef: function (pageNum, pageRef) {}
  };
  return SimpleLinkService;
})();

var PDFViewerApplication = {
  initialDestination: null,
  initialized: false,
  fellback: false,
  pdfDocument: null,
  /** @type {PDFViewer} */
  pdfViewer: null,
  /** @type {PDFRenderingQueue} */
  pdfRenderingQueue: null,
  /** @type {PDFLinkService} */
  pdfLinkService: null,
  /** @type {PDFHistory} */
  pdfHistory: null,
  isInitialViewSet: false,
  animationStartedPromise: null,
  preferencePdfBugEnabled: false,
  preferenceShowPreviousViewOnLoad: true,
  preferenceDefaultZoomValue: '',
  isViewerEmbedded: (window.parent !== window),
  url: '',

  // called once when the document is loaded
  initialize: function pdfViewInitialize() {
    var pdfRenderingQueue = new PDFRenderingQueue();
    pdfRenderingQueue.onIdle = this.cleanup.bind(this);
    this.pdfRenderingQueue = pdfRenderingQueue;

    var pdfLinkService = new PDFLinkService();
    this.pdfLinkService = pdfLinkService;

    var container = document.getElementById('viewerContainer');
    var viewer = document.getElementById('viewer');
    this.pdfViewer = new PDFViewer({
      container: container,
      viewer: viewer,
      renderingQueue: pdfRenderingQueue,
      linkService: pdfLinkService
    });
    pdfRenderingQueue.setViewer(this.pdfViewer);
    pdfLinkService.setViewer(this.pdfViewer);

    Preferences.initialize();

    this.pdfHistory = new PDFHistory({
      linkService: pdfLinkService
    });
    pdfLinkService.setHistory(this.pdfHistory);

    var self = this;
    var initializedPromise = Promise.all([
      Preferences.get('enableWebGL').then(function resolved(value) {
        PDFJS.disableWebGL = !value;
      }),
      Preferences.get('pdfBugEnabled').then(function resolved(value) {
        self.preferencePdfBugEnabled = value;
      }),
      Preferences.get('showPreviousViewOnLoad').then(function resolved(value) {
        self.preferenceShowPreviousViewOnLoad = value;
      }),
      Preferences.get('defaultZoomValue').then(function resolved(value) {
        self.preferenceDefaultZoomValue = value;
      }),
      Preferences.get('disableTextLayer').then(function resolved(value) {
        if (PDFJS.disableTextLayer === true) {
          return;
        }
        PDFJS.disableTextLayer = value;
      }),
      Preferences.get('disableRange').then(function resolved(value) {
        if (PDFJS.disableRange === true) {
          return;
        }
        PDFJS.disableRange = value;
      }),
      Preferences.get('disableAutoFetch').then(function resolved(value) {
        PDFJS.disableAutoFetch = value;
      }),
      Preferences.get('disableFontFace').then(function resolved(value) {
        if (PDFJS.disableFontFace === true) {
          return;
        }
        PDFJS.disableFontFace = value;
      }),
      Preferences.get('useOnlyCssZoom').then(function resolved(value) {
        PDFJS.useOnlyCssZoom = value;
      })
      // TODO move more preferences and other async stuff here
    ]).catch(function (reason) { });

    return initializedPromise.then(function () {
      PDFViewerApplication.initialized = true;
    });
  },

  zoomIn: function pdfViewZoomIn(ticks) {
    var newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale * DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.ceil(newScale * 10) / 10;
      newScale = Math.min(MAX_SCALE, newScale);
    } while (--ticks > 0 && newScale < MAX_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
  },

  zoomOut: function pdfViewZoomOut(ticks) {
    var newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale / DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.floor(newScale * 10) / 10;
      newScale = Math.max(MIN_SCALE, newScale);
    } while (--ticks > 0 && newScale > MIN_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
  },

  get pagesCount() {
    return this.pdfDocument.numPages;
  },

  set page(val) {
    this.pdfLinkService.page = val;
  },

  get page() { // TODO remove
    return this.pdfLinkService.page;
  },


  get supportsFullscreen() {
    var doc = document.documentElement;
    var support = !!(doc.requestFullscreen || doc.mozRequestFullScreen ||
                     doc.webkitRequestFullScreen || doc.msRequestFullscreen);

    if (document.fullscreenEnabled === false ||
        document.mozFullScreenEnabled === false ||
        document.webkitFullscreenEnabled === false ||
        document.msFullscreenEnabled === false) {
      support = false;
    }
    if (support && PDFJS.disableFullscreen === true) {
      support = false;
    }

    return PDFJS.shadow(this, 'supportsFullscreen', support);
  },

  get supportsIntegratedFind() {
    var support = false;

    return PDFJS.shadow(this, 'supportsIntegratedFind', support);
  },

  get supportsDocumentFonts() {
    var support = true;

    return PDFJS.shadow(this, 'supportsDocumentFonts', support);
  },

  get supportsDocumentColors() {
    var support = true;

    return PDFJS.shadow(this, 'supportsDocumentColors', support);
  },

  get loadingBar() {
    var bar = new ProgressBar('#loadingBar', {});

    return PDFJS.shadow(this, 'loadingBar', bar);
  },


  setTitleUsingUrl: function pdfViewSetTitleUsingUrl(url) {
  },

  setTitle: function pdfViewSetTitle(title) {
  },

  close: function pdfViewClose() {
    var errorWrapper = document.getElementById('errorWrapper');
    errorWrapper.setAttribute('hidden', 'true');

    if (!this.pdfDocument) {
      return;
    }

    this.pdfDocument.destroy();
    this.pdfDocument = null;

    this.pdfViewer.setDocument(null);
    this.pdfLinkService.setDocument(null, null);

    if (typeof PDFBug !== 'undefined') {
      PDFBug.cleanup();
    }
  },

  // TODO(mack): This function signature should really be pdfViewOpen(url, args)
  open: function pdfViewOpen(file, scale, pdfDataRangeTransport, args) {
    if (this.pdfDocument) {
      // Reload the preferences if a document was previously opened.
      Preferences.reload();
    }
    this.close();

    var parameters = {};
    if (typeof file === 'string') { // URL
      this.setTitleUsingUrl(file);
      parameters.url = file;
    } else if (file && 'byteLength' in file) { // ArrayBuffer
      parameters.data = file;
    } else if (file.url && file.originalUrl) {
      this.setTitleUsingUrl(file.originalUrl);
      parameters.url = file.url;
    }
    if (args) {
      for (var prop in args) {
        parameters[prop] = args[prop];
      }
    }

    var self = this;

    function getDocumentProgress(progressData) {
      self.progress(progressData.loaded / progressData.total);
    }

    PDFJS.getDocument(parameters, pdfDataRangeTransport, null,
                      getDocumentProgress).then(
      function getDocumentCallback(pdfDocument) {
        self.load(pdfDocument, scale);
      },
      function getDocumentError(exception) {
        var message = exception && exception.message;
        var loadingErrorMessage = mozL10n.get('loading_error', null,
          'An error occurred while loading the PDF.');

        if (exception instanceof PDFJS.InvalidPDFException) {
          // change error message also for other builds
          loadingErrorMessage = mozL10n.get('invalid_file_error', null,
                                            'Invalid or corrupted PDF file.');
        } else if (exception instanceof PDFJS.MissingPDFException) {
          // special message for missing PDF's
          loadingErrorMessage = mozL10n.get('missing_file_error', null,
                                            'Missing PDF file.');
        } else if (exception instanceof PDFJS.UnexpectedResponseException) {
          loadingErrorMessage = mozL10n.get('unexpected_response_error', null,
                                            'Unexpected server response.');
        }

        var moreInfo = {
          message: message
        };
        self.error(loadingErrorMessage, moreInfo);
      }
    );

  },

  fallback: function pdfViewFallback(featureId) {
  },

  /**
   * Show the error box.
   * @param {String} message A message that is human readable.
   * @param {Object} moreInfo (optional) Further information about the error
   *                            that is more technical.  Should have a 'message'
   *                            and optionally a 'stack' property.
   */
  error: function pdfViewError(message, moreInfo) {
    var moreInfoText = mozL10n.get('error_version_info',
      {version: PDFJS.version || '?', build: PDFJS.build || '?'},
      'PDF.js v{{version}} (build: {{build}})') + '\n';
    if (moreInfo) {
      moreInfoText +=
        mozL10n.get('error_message', {message: moreInfo.message},
        'Message: {{message}}');
      if (moreInfo.stack) {
        moreInfoText += '\n' +
          mozL10n.get('error_stack', {stack: moreInfo.stack},
          'Stack: {{stack}}');
      } else {
        if (moreInfo.filename) {
          moreInfoText += '\n' +
            mozL10n.get('error_file', {file: moreInfo.filename},
            'File: {{file}}');
        }
        if (moreInfo.lineNumber) {
          moreInfoText += '\n' +
            mozL10n.get('error_line', {line: moreInfo.lineNumber},
            'Line: {{line}}');
        }
      }
    }

    var errorWrapper = document.getElementById('errorWrapper');
    errorWrapper.removeAttribute('hidden');

    var errorMessage = document.getElementById('errorMessage');
    errorMessage.textContent = message;

    var closeButton = document.getElementById('errorClose');
    closeButton.onclick = function() {
      errorWrapper.setAttribute('hidden', 'true');
    };

    var errorMoreInfo = document.getElementById('errorMoreInfo');
    var moreInfoButton = document.getElementById('errorShowMore');
    var lessInfoButton = document.getElementById('errorShowLess');
    moreInfoButton.onclick = function() {
      errorMoreInfo.removeAttribute('hidden');
      moreInfoButton.setAttribute('hidden', 'true');
      lessInfoButton.removeAttribute('hidden');
      errorMoreInfo.style.height = errorMoreInfo.scrollHeight + 'px';
    };
    lessInfoButton.onclick = function() {
      errorMoreInfo.setAttribute('hidden', 'true');
      moreInfoButton.removeAttribute('hidden');
      lessInfoButton.setAttribute('hidden', 'true');
    };
    moreInfoButton.oncontextmenu = noContextMenuHandler;
    lessInfoButton.oncontextmenu = noContextMenuHandler;
    closeButton.oncontextmenu = noContextMenuHandler;
    moreInfoButton.removeAttribute('hidden');
    lessInfoButton.setAttribute('hidden', 'true');
    errorMoreInfo.value = moreInfoText;
  },

  progress: function pdfViewProgress(level) {
    var percent = Math.round(level * 100);
    // When we transition from full request to range requests, it's possible
    // that we discard some of the loaded data. This can cause the loading
    // bar to move backwards. So prevent this by only updating the bar if it
    // increases.
    if (percent > this.loadingBar.percent || isNaN(percent)) {
      this.loadingBar.percent = percent;

      // When disableAutoFetch is enabled, it's not uncommon for the entire file
      // to never be fetched (depends on e.g. the file structure). In this case
      // the loading bar will not be completely filled, nor will it be hidden.
      // To prevent displaying a partially filled loading bar permanently, we
      // hide it when no data has been loaded during a certain amount of time.
      if (PDFJS.disableAutoFetch && percent) {
        if (this.disableAutoFetchLoadingBarTimeout) {
          clearTimeout(this.disableAutoFetchLoadingBarTimeout);
          this.disableAutoFetchLoadingBarTimeout = null;
        }
        this.loadingBar.show();

        this.disableAutoFetchLoadingBarTimeout = setTimeout(function () {
          this.loadingBar.hide();
          this.disableAutoFetchLoadingBarTimeout = null;
        }.bind(this), DISABLE_AUTO_FETCH_LOADING_BAR_TIMEOUT);
      }
    }
  },

  load: function pdfViewLoad(pdfDocument, scale) {
    var self = this;
    scale = scale || UNKNOWN_SCALE;

    this.pdfDocument = pdfDocument;

    var downloadedPromise = pdfDocument.getDownloadInfo().then(function() {
      self.downloadComplete = true;
      self.loadingBar.hide();
    });

    var pagesCount = pdfDocument.numPages;
    document.getElementById('numPages').textContent =
      mozL10n.get('page_of', {pageCount: pagesCount}, 'of {{pageCount}}');
    document.getElementById('pageNumber').max = pagesCount;

    var id = this.documentFingerprint = pdfDocument.fingerprint;
    var store = this.store = new ViewHistory(id);

    var baseDocumentUrl = null;
    this.pdfLinkService.setDocument(pdfDocument, baseDocumentUrl);

    var pdfViewer = this.pdfViewer;
    pdfViewer.currentScale = scale;
    pdfViewer.setDocument(pdfDocument);
    var firstPagePromise = pdfViewer.firstPagePromise;
    var pagesPromise = pdfViewer.pagesPromise;
    var onePageRendered = pdfViewer.onePageRendered;

    this.isInitialViewSet = false;

    firstPagePromise.then(function(pdfPage) {
      downloadedPromise.then(function () {
        var event = document.createEvent('CustomEvent');
        event.initCustomEvent('documentload', true, true, {});
        window.dispatchEvent(event);
      });

      self.loadingBar.setWidth(document.getElementById('viewer'));

      if (!PDFJS.disableHistory && !self.isViewerEmbedded) {
        // The browsing history is only enabled when the viewer is standalone,
        // i.e. not when it is embedded in a web page.
        if (!self.preferenceShowPreviousViewOnLoad) {
          self.pdfHistory.clearHistoryState();
        }
        self.pdfHistory.initialize(self.documentFingerprint);

        if (self.pdfHistory.initialDestination) {
          self.initialDestination = self.pdfHistory.initialDestination;
        }
      }

      store.initializedPromise.then(function resolved() {
        var storedHash = null;
        if (self.preferenceShowPreviousViewOnLoad &&
            store.get('exists', false)) {
          var pageNum = store.get('page', '1');
          var zoom = self.preferenceDefaultZoomValue ||
                     store.get('zoom', DEFAULT_SCALE_VALUE);
          var left = store.get('scrollLeft', '0');
          var top = store.get('scrollTop', '0');

          storedHash = 'page=' + pageNum + '&zoom=' + zoom + ',' +
                       left + ',' + top;
        } else if (self.preferenceDefaultZoomValue) {
          storedHash = 'page=1&zoom=' + self.preferenceDefaultZoomValue;
        }
        self.setInitialView(storedHash, scale);

        // Make all navigation keys work on document load,
        // unless the viewer is embedded in a web page.
        if (!self.isViewerEmbedded) {
          self.pdfViewer.focus();
        }
      }, function rejected(reason) {
        console.error(reason);
        self.setInitialView(null, scale);
      });
    });

    // outline depends on pagesRefMap
    var promises = [pagesPromise, this.animationStartedPromise];

    pdfDocument.getMetadata().then(function(data) {
      var info = data.info, metadata = data.metadata;
      self.documentInfo = info;
      self.metadata = metadata;

      // Provides some basic debug information
      console.log('PDF ' + pdfDocument.fingerprint + ' [' +
                  info.PDFFormatVersion + ' ' + (info.Producer || '-').trim() +
                  ' / ' + (info.Creator || '-').trim() + ']' +
                  ' (PDF.js: ' + (PDFJS.version || '-') +
                  (!PDFJS.disableWebGL ? ' [WebGL]' : '') + ')');

      var pdfTitle;
      if (metadata && metadata.has('dc:title')) {
        var title = metadata.get('dc:title');
        // Ghostscript sometimes return 'Untitled', sets the title to 'Untitled'
        if (title !== 'Untitled') {
          pdfTitle = title;
        }
      }

      if (!pdfTitle && info && info['Title']) {
        pdfTitle = info['Title'];
      }

      if (pdfTitle) {
        self.setTitle(pdfTitle + ' - ' + document.title);
      }

      if (info.IsAcroFormPresent) {
        console.warn('Warning: AcroForm/XFA is not supported');
        self.fallback(PDFJS.UNSUPPORTED_FEATURES.forms);
      }

    });
  },

  setInitialView: function pdfViewSetInitialView(storedHash, scale) {
    this.isInitialViewSet = true;

    // When opening a new file, when one is already loaded in the viewer,
    // ensure that the 'pageNumber' element displays the correct value.
    document.getElementById('pageNumber').value =
      this.pdfViewer.currentPageNumber;

    if (this.initialDestination) {
      this.pdfLinkService.navigateTo(this.initialDestination);
      this.initialDestination = null;
    } else if (storedHash) {
      this.pdfLinkService.setHash(storedHash);
    } else if (scale) {
      this.pdfViewer.currentScaleValue = scale;
      this.page = 1;
    }

    if (!this.pdfViewer.currentScaleValue) {
      // Scale was not initialized: invalid bookmark or scale was not specified.
      // Setting the default one.
      this.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    }
  },

  cleanup: function pdfViewCleanup() {
    this.pdfViewer.cleanup();
    this.pdfDocument.cleanup();
  },

  forceRendering: function pdfViewForceRendering() {
    this.pdfRenderingQueue.renderHighestPriority();
  },

  // Whether all pages of the PDF have the same width and height.
  get hasEqualPageSizes() {
    var firstPage = this.pdfViewer.getPageView(0);
    for (var i = 1, ii = this.pagesCount; i < ii; ++i) {
      var pageView = this.pdfViewer.getPageView(i);
      if (pageView.width !== firstPage.width ||
          pageView.height !== firstPage.height) {
        return false;
      }
    }
    return true;
  }

};
window.PDFView = PDFViewerApplication; // obsolete name, using it as an alias


function webViewerLoad(evt) {
  PDFViewerApplication.initialize().then(function () {
	webViewerInitialized("");
  });
}

function loadPdfFile(url) {
	PDFViewerApplication.open(url, 0);
}

function closePdfFile() {
	PDFViewerApplication.close();
}

function webViewerInitialized(url) {
  var queryString = document.location.search.substring(1);
  var params = parseQueryString(queryString);
  var file = url;

  var locale = PDFJS.locale || navigator.language;

  if (PDFViewerApplication.preferencePdfBugEnabled) {
    // Special debugging flags in the hash section of the URL.
    var hash = document.location.hash.substring(1);
    var hashParams = parseQueryString(hash);

    if ('disableworker' in hashParams) {
      PDFJS.disableWorker = (hashParams['disableworker'] === 'true');
    }
    if ('disablerange' in hashParams) {
      PDFJS.disableRange = (hashParams['disablerange'] === 'true');
    }
    if ('disablestream' in hashParams) {
      PDFJS.disableStream = (hashParams['disablestream'] === 'true');
    }
    if ('disableautofetch' in hashParams) {
      PDFJS.disableAutoFetch = (hashParams['disableautofetch'] === 'true');
    }
    if ('disablefontface' in hashParams) {
      PDFJS.disableFontFace = (hashParams['disablefontface'] === 'true');
    }
    if ('disablehistory' in hashParams) {
      PDFJS.disableHistory = (hashParams['disablehistory'] === 'true');
    }
    if ('webgl' in hashParams) {
      PDFJS.disableWebGL = (hashParams['webgl'] !== 'true');
    }
    if ('useonlycsszoom' in hashParams) {
      PDFJS.useOnlyCssZoom = (hashParams['useonlycsszoom'] === 'true');
    }
    if ('verbosity' in hashParams) {
      PDFJS.verbosity = hashParams['verbosity'] | 0;
    }
    if ('ignorecurrentpositiononzoom' in hashParams) {
      IGNORE_CURRENT_POSITION_ON_ZOOM =
        (hashParams['ignorecurrentpositiononzoom'] === 'true');
    }
    if ('locale' in hashParams) {
      locale = hashParams['locale'];
    }
    if ('textlayer' in hashParams) {
      switch (hashParams['textlayer']) {
        case 'off':
          PDFJS.disableTextLayer = true;
          break;
        case 'visible':
        case 'shadow':
        case 'hover':
          var viewer = document.getElementById('viewer');
          viewer.classList.add('textLayer-' + hashParams['textlayer']);
          break;
      }
    }
    if ('pdfbug' in hashParams) {
      PDFJS.pdfBug = true;
      var pdfBug = hashParams['pdfbug'];
      var enabled = pdfBug.split(',');
      PDFBug.enable(enabled);
      PDFBug.init();
    }
  }

  mozL10n.setLanguage(locale);

  // Listen for unsupported features to trigger the fallback UI.
  PDFJS.UnsupportedManager.listen(
    PDFViewerApplication.fallback.bind(PDFViewerApplication));

  // Suppress context menus for some controls
  document.getElementById('scaleSelect').oncontextmenu = noContextMenuHandler;

  var mainContainer = document.getElementById('mainContainer');
  var outerContainer = document.getElementById('outerContainer');
  mainContainer.addEventListener('transitionend', function(e) {
    if (e.target === mainContainer) {
      var event = document.createEvent('UIEvents');
      event.initUIEvent('resize', false, false, window, 0);
      window.dispatchEvent(event);
      outerContainer.classList.remove('sidebarMoving');
    }
  }, true);

  document.getElementById('previous').addEventListener('click',
    function() {
      PDFViewerApplication.page--;
    });

  document.getElementById('next').addEventListener('click',
    function() {
      PDFViewerApplication.page++;
    });

  document.getElementById('zoomIn').addEventListener('click',
    function() {
      PDFViewerApplication.zoomIn();
    });

  document.getElementById('zoomOut').addEventListener('click',
    function() {
      PDFViewerApplication.zoomOut();
    });

  document.getElementById('pageNumber').addEventListener('click', function() {
    this.select();
  });

  document.getElementById('pageNumber').addEventListener('change', function() {
    // Handle the user inputting a floating point number.
    PDFViewerApplication.page = (this.value | 0);

    if (this.value !== (this.value | 0).toString()) {
      this.value = PDFViewerApplication.page;
    }
  });

  document.getElementById('scaleSelect').addEventListener('change', function() {
    if (this.value === 'custom') {
      return;
    }
    PDFViewerApplication.pdfViewer.currentScaleValue = this.value;
  });

  if (file && file.lastIndexOf('file:', 0) === 0) {
    // file:-scheme. Load the contents in the main thread because QtWebKit
    // cannot load file:-URLs in a Web Worker. file:-URLs are usually loaded
    // very quickly, so there is no need to set up progress event listeners.
    PDFViewerApplication.setTitleUsingUrl(file);
    var xhr = new XMLHttpRequest();
    xhr.onload = function() {
      PDFViewerApplication.open(new Uint8Array(xhr.response), 0);
    };
    try {
      xhr.open('GET', file);
      xhr.responseType = 'arraybuffer';
      xhr.send();
    } catch (e) {
      PDFViewerApplication.error(mozL10n.get('loading_error', null,
        'An error occurred while loading the PDF.'), e);
    }
    return;
  }

  if (file) {
    PDFViewerApplication.open(file, 0);
  }
}

document.addEventListener('DOMContentLoaded', webViewerLoad, true);

document.addEventListener('pagerendered', function (e) {
  var pageNumber = e.detail.pageNumber;
  var pageIndex = pageNumber - 1;
  var pageView = PDFViewerApplication.pdfViewer.getPageView(pageIndex);

  if (PDFJS.pdfBug && Stats.enabled && pageView.stats) {
    Stats.add(pageNumber, pageView.stats);
  }

  if (pageView.error) {
    PDFViewerApplication.error(mozL10n.get('rendering_error', null,
      'An error occurred while rendering the page.'), pageView.error);
  }

  // If the page is still visible when it has finished rendering,
  // ensure that the page number input loading indicator is hidden.
  if (pageNumber === PDFViewerApplication.page) {
    var pageNumberInput = document.getElementById('pageNumber');
    pageNumberInput.classList.remove(PAGE_NUMBER_LOADING_INDICATOR);
  }

}, true);

document.addEventListener('textlayerrendered', function (e) {
  var pageIndex = e.detail.pageNumber - 1;
  var pageView = PDFViewerApplication.pdfViewer.getPageView(pageIndex);

}, true);

document.addEventListener('namedaction', function (e) {
  // Processing couple of named actions that might be useful.
  // See also PDFLinkService.executeNamedAction
  var action = e.action;
  switch (action) {
    case 'GoToPage':
      document.getElementById('pageNumber').focus();
      break;
  }
}, true);

window.addEventListener('updateviewarea', function (evt) {
  if (!PDFViewerApplication.initialized) {
    return;
  }
  var location = evt.location;

  PDFViewerApplication.store.initializedPromise.then(function() {
    PDFViewerApplication.store.setMultiple({
      'exists': true,
      'page': location.pageNumber,
      'zoom': location.scale,
      'scrollLeft': location.left,
      'scrollTop': location.top
    }).catch(function() {
      // unable to write to storage
    });
  });

  // Show/hide the loading indicator in the page number input element.
  var pageNumberInput = document.getElementById('pageNumber');
  var currentPage =
    PDFViewerApplication.pdfViewer.getPageView(PDFViewerApplication.page - 1);

  if (currentPage.renderingState === RenderingStates.FINISHED) {
    pageNumberInput.classList.remove(PAGE_NUMBER_LOADING_INDICATOR);
  } else {
    pageNumberInput.classList.add(PAGE_NUMBER_LOADING_INDICATOR);
  }
}, true);

window.addEventListener('resize', function webViewerResize(evt) {
  if (PDFViewerApplication.initialized) {
    var currentScaleValue = PDFViewerApplication.pdfViewer.currentScaleValue;
    if (currentScaleValue === 'auto' ||
        currentScaleValue === 'page-fit' ||
        currentScaleValue === 'page-width') {
      // Note: the scale is constant for 'page-actual'.
      PDFViewerApplication.pdfViewer.currentScaleValue = currentScaleValue;
    } else if (!currentScaleValue) {
      // Normally this shouldn't happen, but if the scale wasn't initialized
      // we set it to the default value in order to prevent any issues.
      // (E.g. the document being rendered with the wrong scale on load.)
      PDFViewerApplication.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    }
    PDFViewerApplication.pdfViewer.update();
  }

});

window.addEventListener('hashchange', function webViewerHashchange(evt) {
  if (PDFViewerApplication.pdfHistory.isHashChangeUnlocked) {
    var hash = document.location.hash.substring(1);
    if (!hash) {
      return;
    }
    if (!PDFViewerApplication.isInitialViewSet) {
    } else {
      PDFViewerApplication.pdfLinkService.setHash(hash);
    }
  }
});

window.addEventListener('change', function webViewerChange(evt) {
  var files = evt.target.files;
  if (!files || files.length === 0) {
    return;
  }
  var file = files[0];

  if (!PDFJS.disableCreateObjectURL &&
      typeof URL !== 'undefined' && URL.createObjectURL) {
    PDFViewerApplication.open(URL.createObjectURL(file), 0);
  } else {
    // Read the local file into a Uint8Array.
    var fileReader = new FileReader();
    fileReader.onload = function webViewerChangeFileReaderOnload(evt) {
      var buffer = evt.target.result;
      var uint8Array = new Uint8Array(buffer);
      PDFViewerApplication.open(uint8Array, 0);
    };
    fileReader.readAsArrayBuffer(file);
  }

  PDFViewerApplication.setTitleUsingUrl(file.name);
}, true);

function selectScaleOption(value) {
  var options = document.getElementById('scaleSelect').options;
  var predefinedValueFound = false;
  for (var i = 0, ii = options.length; i < ii; i++) {
    var option = options[i];
    if (option.value !== value) {
      option.selected = false;
      continue;
    }
    option.selected = true;
    predefinedValueFound = true;
  }
  return predefinedValueFound;
}

window.addEventListener('localized', function localized(evt) {
  document.getElementsByTagName('html')[0].dir = mozL10n.getDirection();

  PDFViewerApplication.animationStartedPromise.then(function() {
    // Adjust the width of the zoom box to fit the content.
    // Note: If the window is narrow enough that the zoom box is not visible,
    //       we temporarily show it to be able to adjust its width.
    var container = document.getElementById('scaleSelectContainer');
    if (container.clientWidth === 0) {
      container.setAttribute('style', 'display: inherit;');
    }
    if (container.clientWidth > 0) {
      var select = document.getElementById('scaleSelect');
      select.setAttribute('style', 'min-width: inherit;');
      var width = select.clientWidth + SCALE_SELECT_CONTAINER_PADDING;
      select.setAttribute('style', 'min-width: ' +
                                   (width + SCALE_SELECT_PADDING) + 'px;');
      container.setAttribute('style', 'min-width: ' + width + 'px; ' +
                                      'max-width: ' + width + 'px;');
    }

  });
}, true);

window.addEventListener('scalechange', function scalechange(evt) {
  document.getElementById('zoomOut').disabled = (evt.scale === MIN_SCALE);
  document.getElementById('zoomIn').disabled = (evt.scale === MAX_SCALE);

  // Update the 'scaleSelect' DOM element.
  var predefinedValueFound = selectScaleOption(evt.presetValue ||
                                               '' + evt.scale);
  if (!predefinedValueFound) {
    var customScaleOption = document.getElementById('customScaleOption');
    var customScale = Math.round(evt.scale * 10000) / 100;
    customScaleOption.textContent =
      mozL10n.get('page_scale_percent', { scale: customScale }, '{{scale}}%');
    customScaleOption.selected = true;
  }
  if (!PDFViewerApplication.initialized) {
    return;
  }
  PDFViewerApplication.pdfViewer.update();
}, true);

window.addEventListener('pagechange', function pagechange(evt) {
  var page = evt.pageNumber;
  if (evt.previousPageNumber !== page) {
    document.getElementById('pageNumber').value = page;
  }
  var numPages = PDFViewerApplication.pagesCount;

  document.getElementById('previous').disabled = (page <= 1);
  document.getElementById('next').disabled = (page >= numPages);

  // we need to update stats
  if (PDFJS.pdfBug && Stats.enabled) {
    var pageView = PDFViewerApplication.pdfViewer.getPageView(page - 1);
    if (pageView.stats) {
      Stats.add(page, pageView.stats);
    }
  }
}, true);

function handleMouseWheel(evt) {
  var MOUSE_WHEEL_DELTA_FACTOR = 40;
  var ticks = (evt.type === 'DOMMouseScroll') ? -evt.detail :
              evt.wheelDelta / MOUSE_WHEEL_DELTA_FACTOR;
  var direction = (ticks < 0) ? 'zoomOut' : 'zoomIn';

  var pdfViewer = PDFViewerApplication.pdfViewer;
  if (evt.ctrlKey || evt.metaKey) {
    // Only zoom the pages, not the entire viewer.
    evt.preventDefault();

    var previousScale = pdfViewer.currentScale;

    PDFViewerApplication[direction](Math.abs(ticks));

    var currentScale = pdfViewer.currentScale;
    if (previousScale !== currentScale) {
      // After scaling the page via zoomIn/zoomOut, the position of the upper-
      // left corner is restored. When the mouse wheel is used, the position
      // under the cursor should be restored instead.
      var scaleCorrectionFactor = currentScale / previousScale - 1;
      var rect = pdfViewer.container.getBoundingClientRect();
      var dx = evt.clientX - rect.left;
      var dy = evt.clientY - rect.top;
      pdfViewer.container.scrollLeft += dx * scaleCorrectionFactor;
      pdfViewer.container.scrollTop += dy * scaleCorrectionFactor;
    }
  }
}

window.addEventListener('DOMMouseScroll', handleMouseWheel);
window.addEventListener('mousewheel', handleMouseWheel);

window.addEventListener('keydown', function keydown(evt) {
  if (OverlayManager.active) {
    return;
  }

  var handled = false;
  var cmd = (evt.ctrlKey ? 1 : 0) |
            (evt.altKey ? 2 : 0) |
            (evt.shiftKey ? 4 : 0) |
            (evt.metaKey ? 8 : 0);

  var pdfViewer = PDFViewerApplication.pdfViewer;
  
  // First, handle the key bindings that are independent whether an input
  // control is selected or not.
  if (cmd === 1 || cmd === 8 || cmd === 5 || cmd === 12) {
    // either CTRL or META key with optional SHIFT.
    switch (evt.keyCode) {
      case 61: // FF/Mac '='
      case 107: // FF '+' and '='
      case 187: // Chrome '+'
      case 171: // FF with German keyboard
        PDFViewerApplication.zoomIn();
        handled = true;
        break;
      case 173: // FF/Mac '-'
      case 109: // FF '-'
      case 189: // Chrome '-'
        PDFViewerApplication.zoomOut();
        handled = true;
        break;
      case 48: // '0'
      case 96: // '0' on Numpad of Swedish keyboard
          // keeping it unhandled (to restore page zoom to 100%)
          setTimeout(function () {
            // ... and resetting the scale after browser adjusts its scale
            pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
          });
          handled = false;
        break;
    }
  }

  // CTRL+ALT or Option+Command
  if (cmd === 3 || cmd === 10) {
    switch (evt.keyCode) {
      case 71: // g
        // focuses input#pageNumber field
        document.getElementById('pageNumber').select();
        handled = true;
        break;
    }
  }

  if (handled) {
    evt.preventDefault();
    return;
  }

  // Some shortcuts should not get handled if a control/input element
  // is selected.
  var curElement = document.activeElement || document.querySelector(':focus');
  var curElementTagName = curElement && curElement.tagName.toUpperCase();
  if (curElementTagName === 'INPUT' ||
      curElementTagName === 'TEXTAREA' ||
      curElementTagName === 'SELECT') {
    // Make sure that the secondary toolbar is closed when Escape is pressed.
    if (evt.keyCode !== 27) { // 'Esc'
      return;
    }
  }
  var ensureViewerFocused = false;

  if (cmd === 0) { // no control key pressed at all.
    switch (evt.keyCode) {
      case 38: // up arrow
      case 33: // pg up
      case 8: // backspace
        if (pdfViewer.currentScaleValue !== 'page-fit') {
          break;
        }
        /* in presentation mode */
        /* falls through */
      case 37: // left arrow
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          break;
        }
        /* falls through */
      case 75: // 'k'
      case 80: // 'p'
        PDFViewerApplication.page--;
        handled = true;
        break;
      case 40: // down arrow
      case 34: // pg down
      case 32: // spacebar
        if (pdfViewer.currentScaleValue !== 'page-fit') {
          break;
        }
        /* falls through */
      case 39: // right arrow
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          break;
        }
        /* falls through */
      case 74: // 'j'
      case 78: // 'n'
        PDFViewerApplication.page++;
        handled = true;
        break;

      case 36: // home
        if (PDFViewerApplication.page > 1) {
          PDFViewerApplication.page = 1;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
      case 35: // end
        if ((PDFViewerApplication.pdfDocument &&
            PDFViewerApplication.page < PDFViewerApplication.pagesCount)) {
          PDFViewerApplication.page = PDFViewerApplication.pagesCount;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
    }
  }

  if (cmd === 4) { // shift-key
    switch (evt.keyCode) {
      case 32: // spacebar
        if (pdfViewer.currentScaleValue !== 'page-fit') {
          break;
        }
        PDFViewerApplication.page--;
        handled = true;
        break;
    }
  }

  if (!handled) {
    // 33=Page Up  34=Page Down  35=End    36=Home
    // 37=Left     38=Up         39=Right  40=Down
    // 32=Spacebar
    if ((evt.keyCode >= 33 && evt.keyCode <= 40) ||
        (evt.keyCode === 32 && curElementTagName !== 'BUTTON')) {
      ensureViewerFocused = true;
    }
  }

  if (cmd === 2) { // alt-key
    switch (evt.keyCode) {
      case 37: // left arrow
        break;
      case 39: // right arrow
        break;
    }
  }

  if (ensureViewerFocused && !pdfViewer.containsElement(curElement)) {
    // The page container is not focused, but a page navigation key has been
    // pressed. Change the focus to the viewer container to make sure that
    // navigation by keyboard works as expected.
    pdfViewer.focus();
  }

  if (handled) {
    evt.preventDefault();
  }
});

(function animationStartedClosure() {
  // The offsetParent is not set until the pdf.js iframe or object is visible.
  // Waiting for first animation.
  PDFViewerApplication.animationStartedPromise = new Promise(
      function (resolve) {
    window.requestAnimationFrame(resolve);
  });
})();

