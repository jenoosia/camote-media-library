(function (cml, $) {

    $(document).ready(function() {
        cml.theBody = new cml.Body();
        ko.applyBindings(cml.theBody, document.getElementById('theBody'));

        var source = {
            dash: 'http://127.0.0.1:1935/vod/mp4:sample.mp4/manifest.mpd',
            hls: 'http://127.0.0.1:1935/vod/mp4:sample.mp4/playlist.m3u8',
            //dash: '//bitdash-a.akamaihd.net/content/MI201109210084_1/mpds/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.mpd',
            //hls: '//bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8',
            poster: '//bitdash-a.akamaihd.net/content/MI201109210084_1/poster.jpg'
        };
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
            VideoPlayer: 'VideoPlayer',
            EbookViewer: 'EbookViewer'
        };
    };

    //Models and Controllers

    cml.Body = function() {
        var s = this;

        s.section = ko.observable('');
        s.state = ko.observable('');

        s.flightNumberInput = ko.observable('');

        s.flightInfo = new cml.FlightInfo();

        s.recommendedTagsMap = {};
        s.recommendedTags = ko.observableArray([]);
        s.recommendedResourcesFull = ko.observableArray([]);
        s.recommendedResourcesView = ko.observableArray([]);

        s.videoPlayer = new cml.VideoPlayerVm();

        s.doUseFlightNumber = function() {
            //TODO Integration with API
            s.initPersonalisedSection();
        };

        s.initPersonalisedSection = function() {
            s.flightInfo.initData(CmlSampleData2);

            s.recommendedResourcesFull([]);
            s.recommendedTagsMap = {};
            s.recommendedTags([]);
            $.each(CmlSampleData2.recommendedItems, function(idx, obj) {
                var res = new cml.Resource(obj);
                s.recommendedResourcesFull.push(res);
                s.recommendedResourcesView.push(res);
                $.each(obj.tags, function(tagIdx, tagObj) {
                    if (!s.recommendedTagsMap[tagObj]) {
                        var oneTag = new cml.ResourceTag(tagObj);
                        s.recommendedTags.push(oneTag);
                        s.recommendedTagsMap[tagObj] = oneTag;
                    }

                    var theTag = s.recommendedTagsMap[tagObj];
                    theTag.relatedResources.push(res);
                });
            });

            s.state(cml.Const.State.Personalised);
        };

        s.doViewResource = function(res, evt) {
            if (res.typeIsVideo()) {
                s.state(cml.Const.State.VideoPlayer);
                s.videoPlayer.init(res);
            } else {
                //TODO Ebook Viewer
            }
        };

        s.doVideoPlayerBack = function() {
            s.videoPlayer.destroy();
            s.state(cml.Const.State.Personalised);
        };

        s.init = function() {
            s.section(cml.Const.Section.Home);
            s.state(cml.Const.State.Welcome);

            s.flightNumberInput('');

            //TODO Others
        };
        s.init();
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
        
        s.initData = function(data) {
            s.flightNumber(data.flightNumber);
            s.scheduled(data.scheduled);
            s.estimated(data.estimated);
            s.destCity(data.destCity);
            s.destCountry(data.destCountry);
            s.terminal(data.terminal);
            s.row(data.row);
            s.gate(data.gate);
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
            return s.type() == 'video';
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