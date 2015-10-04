(function (cml, $) {

    $(document).ready(function() {
        cml.theBody = new cml.Body();
        ko.applyBindings(cml.theBody, document.getElementById('theBody'));
    });

    //Public Variables

    cml.theBody = null;

    //Constants

    cml.Const = new function() {
        var s = this;

        s.Section = {
            Home: 'Home',
            Watch: 'Watch',
            Read: 'Read'
        };

        s.State = {
            Neutral: 'Neutral',
            Welcome: 'Welcome',
            Personalised: 'Personalised',
            GenericPopularNew: 'GenericPopularNew',
            VideoPlayer: 'VideoPlayer',
            EbookViewer: 'EbookViewer',
            Watch: 'Watch',
            Read: 'Read'
        };

        s.ResourceType = {
            Video: 'video',
            Document: 'document'
        };
    };

    //Models and Controllers

    cml.Body = function() {
        var s = this;
        var sampleData = CmlSampleData2;

        s.section = ko.observable('');
        s.state = ko.observable('');
        s.previousState = ko.observable('');

        s.flightNumberInput = ko.observable('');

        s.flightInfo = new cml.FlightInfo();

        s.recommendedFilterShown = ko.observable(false);
        s.recommendedFilterBtnText = ko.computed(function() {
            return s.recommendedFilterShown() ? 'Hide Filter' : 'Filter';
        });
        s.recommendedTagsMap = {};
        s.recommendedTags = ko.observableArray([]);
        s.recommendedResourcesFull = ko.observableArray([]);
        s.recommendedResourcesView = ko.observableArray([]);

        s.popularResources = ko.observableArray([]);
        s.newResources = ko.observableArray([]);

        s.documentResources = ko.observableArray([]);
        s.videoResources = ko.observableArray([]);

        s.viewerBackState = ko.observable('');
        s.videoPlayer = new cml.VideoPlayerVm();
        s.ebookViewer = new cml.EbookViewerVm();

        s.doNavHome = function() {
            if (s.state() == cml.Const.State.Watch || s.state() == cml.Const.State.Read) {
                s.state(s.previousState());
                s.previousState('');
            }
        };
        s.doNavWatch = function() {
            if (s.state() != cml.Const.State.Watch) {
                if (s.state() != cml.Const.State.Read) {
                    s.previousState(s.state());
                }
                s.state(cml.Const.State.Watch);
            }
        };
        s.doNavRead = function() {
            if (s.state() != cml.Const.State.Read) {
                if (s.state() != cml.Const.State.Watch) {
                    s.previousState(s.state());
                }
                s.state(cml.Const.State.Read);
            }
        };

        s.doShowFlightInfoModal = function() {
            $('#modalFlightInfo').modal('show');
        };

        s.doShowFlightWarningModal = function() {
            $('#modalFlightWarning').modal('show');
        };

        s.doUseFlightNumber = function() {
            //TODO Integration with API

            //General Flight Information
            if (s.flightNumberInput() == '') {
                s.flightNumberInput('QF4025');
            }
            s.flightInfo.initData(s.flightNumberInput(), sampleData);

            s.initPersonalisedSection();
        };
        s.initPersonalisedSection = function() {
            s.state(cml.Const.State.Personalised);
        };

        s.doSkipFlightNumber = function() {
            //TODO Integration with API
            s.initGenericPopularNewSection();
        };
        s.initGenericPopularNewSection = function() {
            s.state(cml.Const.State.GenericPopularNew);
        };

        s.doViewResource = function(res, evt) {
            if (res.typeIsVideo()) {
                s.state(cml.Const.State.VideoPlayer);
                s.videoPlayer.init(res);
            } else {
                s.state(cml.Const.State.EbookViewer);
                s.ebookViewer.init(res);
            }
        };

        s.doVideoPlayerBack = function() {
            s.videoPlayer.destroy();
            s.state(cml.Const.State.Personalised);
        };
        s.doEbookViewerBack = function() {
            s.ebookViewer.destroy();
            s.state(cml.Const.State.Personalised);
        };

        s.doToggleRecommendedFilter = function() {
            s.recommendedFilterShown(!s.recommendedFilterShown());
        };
        s.toggleRecommendedTag = function(mdl, evt) {
            var prevActive = mdl.active();

            mdl.active(!prevActive);

            if (prevActive) {
                //Remove related resources
                //But for resources with multiple tags, need to check if their other tags are affected.
                var toRemove = [];
                $.each(s.recommendedResourcesView(), function(idx, res) {
                    var hasActive = false;
                    $.each(res.tags(), function(tagIdx, tagNameToCheck) {
                        if (s.recommendedTagsMap[tagNameToCheck].active()) {
                            hasActive = true;
                            return false;
                        }
                    });
                    if (!hasActive) {
                        toRemove.push(res);
                    }
                });
                $.each(toRemove, function(idx, resToRemove) {
                    s.recommendedResourcesView.remove(resToRemove);
                });
            } else {
                //Add related resources
                var resTag = s.recommendedTagsMap[mdl.tag()];
                $.each(resTag.relatedResources(), function(idx, relRes) {
                    if (s.recommendedResourcesView.indexOf(relRes) == -1) {
                        s.recommendedResourcesView.push(relRes);
                    }
                });
            }

        };

        s.initSampleData = function() {
            //Personalised Section
            s.recommendedResourcesFull([]);
            s.recommendedResourcesView([]);
            s.recommendedTagsMap = {};
            s.recommendedTags([]);

            //Popular and New Section
            s.popularResources([]);
            s.newResources([]);

            //Watch and Read Section
            s.videoResources([]);
            s.documentResources([]);

            var allResourcesMap = {};

            $.each(sampleData.recommendedItems, function(idx, obj) {
                var res = new cml.Resource(obj);

                s.recommendedResourcesFull.push(res);
                s.recommendedResourcesView.push(res);

                $.each(obj.tags, function(tagIdx, tagObj) {
                    if (!s.recommendedTagsMap[tagObj]) {
                        var oneTag = new cml.ResourceTag(tagObj);
                        s.recommendedTagsMap[tagObj] = oneTag;
                        s.recommendedTags.push(oneTag);
                    }

                    var theTag = s.recommendedTagsMap[tagObj];
                    theTag.relatedResources.push(res);
                });

                allResourcesMap[res.name()] = res;
            });

            $.each(sampleData.popularItems, function(idx, obj) {
                var res = new cml.Resource(obj);
                s.popularResources.push(res);

                allResourcesMap[res.name()] = res;
            });
            $.each(sampleData.newItems, function(idx, obj) {
                var res = new cml.Resource(obj);
                s.newResources.push(res);

                allResourcesMap[res.name()] = res;
            });

            $.each(Object.keys(allResourcesMap), function(idx, key) {
                var res = allResourcesMap[key];
                if (res.typeIsVideo()) {
                    s.videoResources.push(res);
                } else {
                    s.documentResources.push(res);
                }
            });
        };

        s.init = function() {
            s.section(cml.Const.Section.Home);
            s.state(cml.Const.State.Welcome);
            s.previousState('');
            s.viewerBackState('');

            s.flightNumberInput('');

            //TODO Others

            s.initSampleData();
        };
        s.init();
    };

    cml.EbookViewerVm = function() {
        var s = this;

        s.relatedResource = ko.observable(null);

        s.viewer = false;

        function destroyViewer() {
            closePdfFile();
            s.viewer = false;
        };

        function loadViewer(url) {
            loadPdfFile(url);
            s.viewer = true;
        };

        s.init = function(res) {
            if (s.viewer) {
                s.destroy();
            }

            s.relatedResource(res);

            loadViewer(res.documentUrl());
        };

        s.destroy = function() {
            s.relatedResource(null);
            destroyViewer();
        };
    };

    cml.VideoPlayerVm = function() {
        var s = this;

        s.relatedResource = ko.observable(null);

        s.config = {
            key: '18e24e9053cb39814969cf5a9a1cf789',
            style: {
                width: '100%',
                aspectratio: '16:9',
                controls: true
            }
        };
        s.playerId = 'thePlayer';
        s.player = null;

        function destroyPlayer() {
            if (s.player != null) {
                bitdash(s.playerId).destroy();
                s.player = null;
            }
        }

        function loadPlayer(dash, hls, poster) {
            if (s.player == null) {
                s.config.source = {
                    dash: dash, hls: hls, poster: poster
                };
                bitdash(s.playerId).setup(s.config);
                s.player = {a:'a'};
            }
        }

        s.init = function(res) {
            if (s.player != null) {
                s.destroy();
            }

            s.relatedResource(res);

            loadPlayer(res.dashUrl(), res.hlsUrl(), res.posterUrl());
        };

        s.destroy = function() {
            s.relatedResource(null);
            destroyPlayer();
        };
    };
    
    cml.FlightInfo = function(paramData) {
        var s = this;
        
        s.flightNumber = ko.observable('');
        s.scheduled = ko.observable('');
        s.estimated = ko.observable('');
        s.destCity = ko.observable('');
        s.destCountry = ko.observable('');
        s.terminal = ko.observable('');
        s.row = ko.observable('');
        s.gate = ko.observable('');
        s.filled = ko.observable(false);
        
        s.initData = function(flightNumber, data) {
            s.flightNumber(flightNumber);
            s.scheduled(data.scheduled);
            s.estimated(data.estimated);
            s.destCity(data.destCity);
            s.destCountry(data.destCountry);
            s.terminal(data.terminal);
            s.row(data.row);
            s.gate(data.gate);
            s.filled(true);
        };
        
        if (paramData) {
            s.initData(paramData);
        }
    };

    cml.ResourceTag = function(paramTag) {
        var s = this;

        s.tag = ko.observable(paramTag ? paramTag : '');
        s.active = ko.observable(true);
        s.relatedResources = ko.observableArray([]);
    };

    cml.Resource = function(paramData) {
        var s = this;

        s.name = ko.observable('');
        s.description = ko.observable('');
        s.duration = ko.observable(0);
        s.thumbnailUrl = ko.observable('');
        s.tags = ko.observableArray([]);
        s.type = ko.observable('');

        s.documentUrl = ko.observable('');

        s.dashUrl = ko.observable('');
        s.hlsUrl = ko.observable('');
        s.posterUrl = ko.observable('');

        s.typeIsVideo = ko.computed(function() {
            return s.type() == cml.Const.ResourceType.Video;
        });

        s.durationText = ko.computed(function() {
            var minutes = s.duration() / 60;
            var hours = minutes / 60;

            var text = '';

            if(Math.floor(hours) > 0) {
                text += Math.floor(hours);
                text += " hr ";
            }

            var minDiff =  Math.floor(minutes) - (Math.floor(hours) * 60);
            if(minDiff > 0) {
                if (minDiff < 10) {
                    text += "0";
                    text += minDiff;
                } else {
                    text += minDiff;
                }
                text += " min ";
            }

            var secDiff = s.duration() - (Math.floor(minutes) * 60);
            if(secDiff > 0) {
                if(secDiff <10) {
                    text += "0";
                    text += secDiff;
                } else {
                    text += secDiff;
                }
                text += " sec ";
            }
            return text;
        });

        s.initData = function(data) {
            s.name(data.name);
            s.description(data.description);
            s.duration(data.duration);
            s.thumbnailUrl(data.thumbnailUrl);
            s.tags(data.tags);
            s.type(data.type);
            s.documentUrl(data.documentUrl);
            s.dashUrl(data.dashUrl);
            s.hlsUrl(data.hlsUrl);
            s.posterUrl(data.posterUrl);
        };

        if (paramData) {
            s.initData(paramData);
        }
    };



})(window.cml = window.cml || {}, jQuery);