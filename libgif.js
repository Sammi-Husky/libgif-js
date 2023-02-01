//*** *** *** *** LIBGIF PLAYBACK *** *** *** *** *** // 

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        root.SuperGif = factory();
    }
}(this, function () {
    // Generic functions
    var bitsToNum = function (ba) {
        return ba.reduce(function (s, n) {
            return s * 2 + n;
        }, 0);
    };

    var byteToBitArr = function (bite) {
        var a = [];
        for (var i = 7; i >= 0; i--) {
            a.push( !! (bite & (1 << i)));
        }
        return a;
    };

    // Stream
    /**
     * @constructor
     */
    // Make compiler happy.
    var Stream = function (data) {
        this.data = data;
        this.len = this.data.length;
        this.pos = 0;

        this.readByte = function () {
            if (this.pos >= this.data.length) {
                throw new Error('Attempted to read past end of stream.');
            }
            if (data instanceof Uint8Array)
                return data[this.pos++];
            else
                return data.charCodeAt(this.pos++) & 0xFF;
        };

        this.readBytes = function (n) {
            var bytes = [];
            for (var i = 0; i < n; i++) {
                bytes.push(this.readByte());
            }
            return bytes;
        };

        this.read = function (n) {
            var s = '';
            for (var i = 0; i < n; i++) {
                s += String.fromCharCode(this.readByte());
            }
            return s;
        };

        this.readUnsigned = function () { // Little-endian.
            var a = this.readBytes(2);
            return (a[1] << 8) + a[0];
        };
    };

    var lzwDecode = function (minCodeSize, data) {
        // TODO: Now that the GIF parser is a bit different, maybe this should get an array of bytes instead of a String?
        var pos = 0; // Maybe this streaming thing should be merged with the Stream?
        var readCode = function (size) {
            var code = 0;
            for (var i = 0; i < size; i++) {
                if (data.charCodeAt(pos >> 3) & (1 << (pos & 7))) {
                    code |= 1 << i;
                }
                pos++;
            }
            return code;
        };

        var output = [];

        var clearCode = 1 << minCodeSize;
        var eoiCode = clearCode + 1;

        var codeSize = minCodeSize + 1;

        var dict = [];

        var clear = function () {
            dict = [];
            codeSize = minCodeSize + 1;
            for (var i = 0; i < clearCode; i++) {
                dict[i] = [i];
            }
            dict[clearCode] = [];
            dict[eoiCode] = null;

        };

        var code;
        var last;

        while (true) {
            last = code;
            code = readCode(codeSize);

            if (code === clearCode) {
                clear();
                continue;
            }
            if (code === eoiCode) break;

            if (code < dict.length) {
                if (last !== clearCode) {
                    dict.push(dict[last].concat(dict[code][0]));
                }
            }
            else {
                if (code !== dict.length) throw new Error('Invalid LZW code.');
                dict.push(dict[last].concat(dict[last][0]));
            }
            output.push.apply(output, dict[code]);

            if (dict.length === (1 << codeSize) && codeSize < 12) {
                // If we're at the last code and codeSize is 12, the next code will be a clearCode, and it'll be 12 bits long.
                codeSize++;
            }
        }

        // I don't know if this is technically an error, but some GIFs do it.
        //if (Math.ceil(pos / 8) !== data.length) throw new Error('Extraneous LZW bytes.');
        return output;
    };


    // The actual parsing; returns an object with properties.
    var parseGIF = function (st, handler) {
        handler || (handler = {});

        // LZW (GIF-specific)
        var parseCT = function (entries) { // Each entry is 3 bytes, for RGB.
            var ct = [];
            for (var i = 0; i < entries; i++) {
                ct.push(st.readBytes(3));
            }
            return ct;
        };

        var readSubBlocks = function () {
            var size, data;
            data = '';
            do {
                size = st.readByte();
                data += st.read(size);
            } while (size !== 0);
            return data;
        };

        var parseHeader = function () {
            var hdr = {};
            hdr.sig = st.read(3);
            hdr.ver = st.read(3);
            if (hdr.sig !== 'GIF') throw new Error('Not a GIF file.'); // XXX: This should probably be handled more nicely.
            hdr.width = st.readUnsigned();
            hdr.height = st.readUnsigned();

            var bits = byteToBitArr(st.readByte());
            hdr.gctFlag = bits.shift();
            hdr.colorRes = bitsToNum(bits.splice(0, 3));
            hdr.sorted = bits.shift();
            hdr.gctSize = bitsToNum(bits.splice(0, 3));

            hdr.bgColor = st.readByte();
            hdr.pixelAspectRatio = st.readByte(); // if not 0, aspectRatio = (pixelAspectRatio + 15) / 64
            if (hdr.gctFlag) {
                hdr.gct = parseCT(1 << (hdr.gctSize + 1));
            }
            handler.hdr && handler.hdr(hdr);
        };

        var parseExt = function (block) {
            var parseGCExt = function (block) {
                var blockSize = st.readByte(); // Always 4
                var bits = byteToBitArr(st.readByte());
                block.reserved = bits.splice(0, 3); // Reserved; should be 000.
                block.disposalMethod = bitsToNum(bits.splice(0, 3));
                block.userInput = bits.shift();
                block.transparencyGiven = bits.shift();

                block.delayTime = st.readUnsigned();

                block.transparencyIndex = st.readByte();

                block.terminator = st.readByte();

                handler.gce && handler.gce(block);
            };

            var parseComExt = function (block) {
                block.comment = readSubBlocks();
                handler.com && handler.com(block);
            };

            var parsePTExt = function (block) {
                // No one *ever* uses this. If you use it, deal with parsing it yourself.
                var blockSize = st.readByte(); // Always 12
                block.ptHeader = st.readBytes(12);
                block.ptData = readSubBlocks();
                handler.pte && handler.pte(block);
            };

            var parseAppExt = function (block) {
                var parseNetscapeExt = function (block) {
                    var blockSize = st.readByte(); // Always 3
                    block.unknown = st.readByte(); // ??? Always 1? What is this?
                    block.iterations = st.readUnsigned();
                    block.terminator = st.readByte();
                    handler.app && handler.app.NETSCAPE && handler.app.NETSCAPE(block);
                };

                var parseUnknownAppExt = function (block) {
                    block.appData = readSubBlocks();
                    // FIXME: This won't work if a handler wants to match on any identifier.
                    handler.app && handler.app[block.identifier] && handler.app[block.identifier](block);
                };

                var blockSize = st.readByte(); // Always 11
                block.identifier = st.read(8);
                block.authCode = st.read(3);
                switch (block.identifier) {
                    case 'NETSCAPE':
                        parseNetscapeExt(block);
                        break;
                    default:
                        parseUnknownAppExt(block);
                        break;
                }
            };

            var parseUnknownExt = function (block) {
                block.data = readSubBlocks();
                handler.unknown && handler.unknown(block);
            };

            block.label = st.readByte();
            switch (block.label) {
                case 0xF9:
                    block.extType = 'gce';
                    parseGCExt(block);
                    break;
                case 0xFE:
                    block.extType = 'com';
                    parseComExt(block);
                    break;
                case 0x01:
                    block.extType = 'pte';
                    parsePTExt(block);
                    break;
                case 0xFF:
                    block.extType = 'app';
                    parseAppExt(block);
                    break;
                default:
                    block.extType = 'unknown';
                    parseUnknownExt(block);
                    break;
            }
        };

        var parseImg = function (img) {
            var deinterlace = function (pixels, width) {
                // Of course this defeats the purpose of interlacing. And it's *probably*
                // the least efficient way it's ever been implemented. But nevertheless...
                var newPixels = new Array(pixels.length);
                var rows = pixels.length / width;
                var cpRow = function (toRow, fromRow) {
                    var fromPixels = pixels.slice(fromRow * width, (fromRow + 1) * width);
                    newPixels.splice.apply(newPixels, [toRow * width, width].concat(fromPixels));
                };

                // See appendix E.
                var offsets = [0, 4, 2, 1];
                var steps = [8, 8, 4, 2];

                var fromRow = 0;
                for (var pass = 0; pass < 4; pass++) {
                    for (var toRow = offsets[pass]; toRow < rows; toRow += steps[pass]) {
                        cpRow(toRow, fromRow)
                        fromRow++;
                    }
                }

                return newPixels;
            };

            img.leftPos = st.readUnsigned();
            img.topPos = st.readUnsigned();
            img.width = st.readUnsigned();
            img.height = st.readUnsigned();

            var bits = byteToBitArr(st.readByte());
            img.lctFlag = bits.shift();
            img.interlaced = bits.shift();
            img.sorted = bits.shift();
            img.reserved = bits.splice(0, 2);
            img.lctSize = bitsToNum(bits.splice(0, 3));

            if (img.lctFlag) {
                img.lct = parseCT(1 << (img.lctSize + 1));
            }

            img.lzwMinCodeSize = st.readByte();

            var lzwData = readSubBlocks();

            img.pixels = lzwDecode(img.lzwMinCodeSize, lzwData);

            if (img.interlaced) { // Move
                img.pixels = deinterlace(img.pixels, img.width);
            }

            handler.img && handler.img(img);
        };

        var parseBlock = function () {
            var block = {};
            block.sentinel = st.readByte();

            switch (String.fromCharCode(block.sentinel)) { // For ease of matching
                case '!':
                    block.type = 'ext';
                    parseExt(block);
                    break;
                case ',':
                    block.type = 'img';
                    parseImg(block);
                    break;
                case ';':
                    block.type = 'eof';
                    handler.eof && handler.eof(block);
                    break;
                default:
                    throw new Error('Unknown block: 0x' + block.sentinel.toString(16)); // TODO: Pad this with a 0.
            }

            if (block.type !== 'eof') setTimeout(parseBlock, 0);
        };

        var parse = function () {
            parseHeader();
            setTimeout(parseBlock, 0);
        };

        parse();
    };

    var SuperGif = function ( opts ) {
        var options = {
            //viewport position
            vp_l: 0,
            vp_t: 0,
            vp_w: null,
            vp_h: null,
            //canvas sizes
            c_w: null,
            c_h: null
        };
        for (var i in opts ) { options[i] = opts[i] }
        if (options.vp_w && options.vp_h) options.is_vp = true;

        var stream;
        var hdr;

        var loadError = null;
        var loading = false;

        var transparency = null;
        var delay = null;
        var disposalMethod = null;
        var disposalRestoreFromIdx = null;
        var lastDisposalMethod = null;
        var frame = null;
        var lastImg = null;

        var playing = true;
        var forward = true;

        var ctx_scaled = false;

        var frames = [];
        var frameOffsets = []; // elements have .x and .y properties

        var gif = options.gif;
        if (typeof options.auto_play == 'undefined')
            options.auto_play = (!gif.getAttribute('rel:auto_play') || gif.getAttribute('rel:auto_play') == '1');

        var onEndListener = (options.hasOwnProperty('on_end') ? options.on_end : null);
        var loopDelay = (options.hasOwnProperty('loop_delay') ? options.loop_delay : 0);
        var overrideLoopMode = (options.hasOwnProperty('loop_mode') ? options.loop_mode : 'auto');
        var drawWhileLoading = (options.hasOwnProperty('draw_while_loading') ? options.draw_while_loading : true);
        var showProgressBar = drawWhileLoading ? (options.hasOwnProperty('show_progress_bar') ? options.show_progress_bar : true) : false;
        var progressBarHeight = (options.hasOwnProperty('progressbar_height') ? options.progressbar_height : 25);
        var progressBarBackgroundColor = (options.hasOwnProperty('progressbar_background_color') ? options.progressbar_background_color : 'rgba(255,255,255,0.4)');
        var progressBarForegroundColor = (options.hasOwnProperty('progressbar_foreground_color') ? options.progressbar_foreground_color : 'rgba(255,0,22,.8)');

        var clear = function () {
            transparency = null;
            delay = null;
            lastDisposalMethod = disposalMethod;
            disposalMethod = null;
            frame = null;
        };

        // XXX: There's probably a better way to handle catching exceptions when
        // callbacks are involved.
        var doParse = function () {
            try {
                parseGIF(stream, handler);
            }
            catch (err) {
                doLoadError('parse');
            }
        };

        var doText = function (text) {
            toolbar.innerHTML = text; // innerText? Escaping? Whatever.
            toolbar.style.visibility = 'visible';
        };

        var setSizes = function(w, h) {
            canvas.width = w * get_canvas_scale();
            canvas.height = h * get_canvas_scale();
        //commented out to preserve mobile scaling -- metal
		//	toolbar.style.minWidth = ( w * get_canvas_scale() ) + 'px';

            tmpCanvas.width = w;
            tmpCanvas.height = h;
            tmpCanvas.style.width = w + 'px';
            tmpCanvas.style.height = h + 'px';
            tmpCanvas.getContext('2d').setTransform(1, 0, 0, 1, 0, 0);
        };

        var setFrameOffset = function(frame, offset) {
            if (!frameOffsets[frame]) {
                frameOffsets[frame] = offset;
                return;
            }
            if (typeof offset.x !== 'undefined') {
                frameOffsets[frame].x = offset.x;
            }
            if (typeof offset.y !== 'undefined') {
                frameOffsets[frame].y = offset.y;
            }
        };

        var doShowProgress = function (pos, length, draw) {
            if (draw && showProgressBar) {
                var height = progressBarHeight;
                var left, mid, top, width;
                if (options.is_vp) {
                    if (!ctx_scaled) {
                        top = (options.vp_t + options.vp_h - height);
                        height = height;
                        left = options.vp_l;
                        mid = left + (pos / length) * options.vp_w;
                        width = canvas.width;
                    } else {
                        top = (options.vp_t + options.vp_h - height) / get_canvas_scale();
                        height = height / get_canvas_scale();
                        left = (options.vp_l / get_canvas_scale() );
                        mid = left + (pos / length) * (options.vp_w / get_canvas_scale());
                        width = canvas.width / get_canvas_scale();
                    }
                    //some debugging, draw rect around viewport
                    if (false) {
                        if (!ctx_scaled) {
                            var l = options.vp_l, t = options.vp_t;
                            var w = options.vp_w, h = options.vp_h;
                        } else {
                            var l = options.vp_l/get_canvas_scale(), t = options.vp_t/get_canvas_scale();
                            var w = options.vp_w/get_canvas_scale(), h = options.vp_h/get_canvas_scale();
                        }
                        ctx.rect(l,t,w,h);
                        ctx.stroke();
                    }
                }
                else {
                    top = (canvas.height - height) / (ctx_scaled ? get_canvas_scale() : 1);
                    mid = ((pos / length) * canvas.width) / (ctx_scaled ? get_canvas_scale() : 1);
                    width = canvas.width / (ctx_scaled ? get_canvas_scale() : 1 );
                    height /= ctx_scaled ? get_canvas_scale() : 1;
                }

                ctx.fillStyle = progressBarBackgroundColor;
                ctx.fillRect(mid, top, width - mid, height);

                ctx.fillStyle = progressBarForegroundColor;
                ctx.fillRect(0, top, mid, height);
            }
        };

        var doLoadError = function (originOfError) {
            var drawError = function () {
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, options.c_w ? options.c_w : hdr.width, options.c_h ? options.c_h : hdr.height);
                ctx.strokeStyle = 'red';
                ctx.lineWidth = 3;
                ctx.moveTo(0, 0);
                ctx.lineTo(options.c_w ? options.c_w : hdr.width, options.c_h ? options.c_h : hdr.height);
                ctx.moveTo(0, options.c_h ? options.c_h : hdr.height);
                ctx.lineTo(options.c_w ? options.c_w : hdr.width, 0);
                ctx.stroke();
            };

            loadError = originOfError;
            hdr = {
                width: gif.width,
                height: gif.height
            }; // Fake header.
            frames = [];
            drawError();
        };

        var doHdr = function (_hdr) {
            hdr = _hdr;
            setSizes(hdr.width, hdr.height)
        };

        var doGCE = function (gce) {
            pushFrame();
            clear();
            transparency = gce.transparencyGiven ? gce.transparencyIndex : null;
            delay = gce.delayTime;
            disposalMethod = gce.disposalMethod;
            // We don't have much to do with the rest of GCE.
        };

        var pushFrame = function () {
            if (!frame) return;
            frames.push({
                            data: frame.getImageData(0, 0, hdr.width, hdr.height),
                            delay: delay
                        });
            frameOffsets.push({ x: 0, y: 0 });
        };

        var doImg = function (img) {
            if (!frame) frame = tmpCanvas.getContext('2d');

            var currIdx = frames.length;

            //ct = color table, gct = global color table
            var ct = img.lctFlag ? img.lct : hdr.gct; // TODO: What if neither exists?

            /*
            Disposal method indicates the way in which the graphic is to
            be treated after being displayed.

            Values :    0 - No disposal specified. The decoder is
                            not required to take any action.
                        1 - Do not dispose. The graphic is to be left
                            in place.
                        2 - Restore to background color. The area used by the
                            graphic must be restored to the background color.
                        3 - Restore to previous. The decoder is required to
                            restore the area overwritten by the graphic with
                            what was there prior to rendering the graphic.

                            Importantly, "previous" means the frame state
                            after the last disposal of method 0, 1, or 2.
            */
            if (currIdx > 0) {
                if (lastDisposalMethod === 3) {
                    // Restore to previous
                    // If we disposed every frame including first frame up to this point, then we have
                    // no composited frame to restore to. In this case, restore to background instead.
                    if (disposalRestoreFromIdx !== null) {
                    	frame.putImageData(frames[disposalRestoreFromIdx].data, 0, 0);
                    } else {
                    	frame.clearRect(lastImg.leftPos, lastImg.topPos, lastImg.width, lastImg.height);
                    }
                } else {
                    disposalRestoreFromIdx = currIdx - 1;
                }

                if (lastDisposalMethod === 2) {
                    // Restore to background color
                    // Browser implementations historically restore to transparent; we do the same.
                    // http://www.wizards-toolkit.org/discourse-server/viewtopic.php?f=1&t=21172#p86079
                    frame.clearRect(lastImg.leftPos, lastImg.topPos, lastImg.width, lastImg.height);
                }
            }
            // else, Undefined/Do not dispose.
            // frame contains final pixel data from the last frame; do nothing

            //Get existing pixels for img region after applying disposal method
            var imgData = frame.getImageData(img.leftPos, img.topPos, img.width, img.height);

            //apply color table colors
            img.pixels.forEach(function (pixel, i) {
                // imgData.data === [R,G,B,A,R,G,B,A,...]
                if (pixel !== transparency) {
                    imgData.data[i * 4 + 0] = ct[pixel][0];
                    imgData.data[i * 4 + 1] = ct[pixel][1];
                    imgData.data[i * 4 + 2] = ct[pixel][2];
                    imgData.data[i * 4 + 3] = 255; // Opaque.
                }
            });

            frame.putImageData(imgData, img.leftPos, img.topPos);

            if (!ctx_scaled) {
                ctx.scale(get_canvas_scale(),get_canvas_scale());
                ctx_scaled = true;
            }

            // We could use the on-page canvas directly, except that we draw a progress
            // bar for each image chunk (not just the final image).
            if (drawWhileLoading) {
                ctx.drawImage(tmpCanvas, 0, 0);
                drawWhileLoading = options.auto_play;
            }

            lastImg = img;
        };

        var player = (function () {
            var i = -1;
            var iterationCount = 0;

            var showingInfo = false;
            var pinned = false;

            /**
             * Gets the index of the frame "up next".
             * @returns {number}
             */
            var getNextFrameNo = function () {
                var delta = (forward ? 1 : -1);
                return (i + delta + frames.length) % frames.length;
            };

            var stepFrame = function (amount) { // XXX: Name is confusing.
                i = i + amount;

                putFrame();
            };

            var step = (function () {
                var stepping = false;

                var completeLoop = function () {
                    if (onEndListener !== null)
                        onEndListener(gif);
                    iterationCount++;

                    if (overrideLoopMode !== false || iterationCount < 0) {
                        doStep();
                    } else {
                        stepping = false;
                        playing = false;
                    }
                };

                var doStep = function () {
                    stepping = playing;
                    if (!stepping) return;

                    stepFrame(1);
                    var delay = frames[i].delay * 10;
                    if (!delay) delay = 100; // FIXME: Should this even default at all? What should it be?

                    var nextFrameNo = getNextFrameNo();
                    if (nextFrameNo === 0) {
                        delay += loopDelay;
                        setTimeout(completeLoop, delay);
                    } else {
                        setTimeout(doStep, delay);
                    }
                };

                return function () {
                    if (!stepping) setTimeout(doStep, 0);
                };
            }());

            var putFrame = function () {
                var offset;
                i = parseInt(i, 10);

                if (i > frames.length - 1){
                    i = 0;
                }

                if (i < 0){
                    i = 0;
                }

                offset = frameOffsets[i];

                tmpCanvas.getContext("2d").putImageData(frames[i].data, offset.x, offset.y);
                ctx.globalCompositeOperation = "copy";
                ctx.drawImage(tmpCanvas, 0, 0);
            };

            var play = function () {
                playing = true;
                step();
            };

            var pause = function () {
                playing = false;
            };


            return {
                init: function () {
                    if (loadError) return;

                    if ( ! (options.c_w && options.c_h) ) {
                        ctx.scale(get_canvas_scale(),get_canvas_scale());
                    }

                    if (options.auto_play) {
                        step();
                    }
                    else {
                        i = 0;
                        putFrame();
                    }
                },
                step: step,
                play: play,
                pause: pause,
                playing: playing,
                move_relative: stepFrame,
                current_frame: function() { return i; },
                length: function() { return frames.length },
                move_to: function ( frame_idx ) {
                    i = frame_idx;
                    putFrame();
                }
            }
        }());

        var doDecodeProgress = function (draw) {
            doShowProgress(stream.pos, stream.data.length, draw);
        };

        var doNothing = function () {};
        /**
         * @param{boolean=} draw Whether to draw progress bar or not; this is not idempotent because of translucency.
         *                       Note that this means that the text will be unsynchronized with the progress bar on non-frames;
         *                       but those are typically so small (GCE etc.) that it doesn't really matter. TODO: Do this properly.
         */
        var withProgress = function (fn, draw) {
            return function (block) {
                fn(block);
                doDecodeProgress(draw);
            };
        };


        var handler = {
            hdr: withProgress(doHdr),
            gce: withProgress(doGCE),
            com: withProgress(doNothing),
            // I guess that's all for now.
            app: {
                // TODO: Is there much point in actually supporting iterations?
                NETSCAPE: withProgress(doNothing)
            },
            img: withProgress(doImg, true),
            eof: function (block) {
                //toolbar.style.display = '';
                pushFrame();
                doDecodeProgress(false);
                if ( ! (options.c_w && options.c_h) ) {
                    canvas.width = hdr.width * get_canvas_scale();
                    canvas.height = hdr.height * get_canvas_scale();
                }
                player.init();
                loading = false;
                if (load_callback) {
                    load_callback(gif);
                }

            }
        };

        var init = function () {
            var parent = gif.parentNode;

            var div = document.createElement('div');
            canvas = document.createElement('canvas');
            ctx = canvas.getContext('2d');
            toolbar = document.createElement('div');

            tmpCanvas = document.createElement('canvas');

            div.width = canvas.width = gif.width;
            div.height = canvas.height = gif.height;
            toolbar.style.minWidth = gif.width + 'px';

            div.className = 'jsgif';
            toolbar.className = 'jsgif_toolbar';
            div.appendChild(canvas);
            div.appendChild(toolbar);

            parent.insertBefore(div, gif);
            parent.removeChild(gif);

            if (options.c_w && options.c_h) setSizes(options.c_w, options.c_h);
            initialized=true;
        };

        var get_canvas_scale = function() {
            var scale;
            if (options.max_width && hdr && hdr.width > options.max_width) {
                scale = options.max_width / hdr.width;
            }
            else {
                scale = 1;
            }
            return scale;
        }

        var canvas, ctx, toolbar, tmpCanvas;
        var initialized = false;
        var load_callback = false;

        var load_setup = function(callback) {
            if (loading) return false;
            if (callback) load_callback = callback;
            else load_callback = false;

            loading = true;
            frames = [];
            clear();
            disposalRestoreFromIdx = null;
            lastDisposalMethod = null;
            frame = null;
            lastImg = null;

            return true;
        }

        return {
            // play controls
            play: player.play,
            pause: player.pause,
            move_relative: player.move_relative,
            move_to: player.move_to,

            // getters for instance vars
            get_playing      : function() { return playing },
            get_canvas       : function() { return canvas },
            get_canvas_scale : function() { return get_canvas_scale() },
            get_loading      : function() { return loading },
            get_auto_play    : function() { return options.auto_play },
            get_length       : function() { return player.length() },
            get_current_frame: function() { return player.current_frame() },
            load_url: function(src,callback){
                if (!load_setup(callback)) return;

                var h = new XMLHttpRequest();
                // new browsers (XMLHttpRequest2-compliant)
                h.open('GET', src, true);

                if ('overrideMimeType' in h) {
                    h.overrideMimeType('text/plain; charset=x-user-defined');
                }

                // old browsers (XMLHttpRequest-compliant)
                else if ('responseType' in h) {
                    h.responseType = 'arraybuffer';
                }

                // IE9 (Microsoft.XMLHTTP-compliant)
                else {
                    h.setRequestHeader('Accept-Charset', 'x-user-defined');
                }

                h.onloadstart = function() {
                    // Wait until connection is opened to replace the gif element with a canvas to avoid a blank img
                    if (!initialized) init();
                };
                h.onload = function(e) {
                    if (this.status != 200) {
                        doLoadError('xhr - response');
                    }
                    // emulating response field for IE9
                    if (!('response' in this)) {
                        this.response = new VBArray(this.responseText).toArray().map(String.fromCharCode).join('');
                    }
                    var data = this.response;
                    if (data.toString().indexOf("ArrayBuffer") > 0) {
                        data = new Uint8Array(data);
                    }

                    stream = new Stream(data);
                    setTimeout(doParse, 0);
                };
                h.onprogress = function (e) {
                    if (e.lengthComputable) doShowProgress(e.loaded, e.total, true);
                };
                h.onerror = function() { doLoadError('xhr'); };
                h.send();
            },
            load: function (callback) {
                this.load_url(gif.getAttribute('rel:animated_src') || gif.src,callback);
            },
            load_raw: function(arr, callback) {
                if (!load_setup(callback)) return;
                if (!initialized) init();
                stream = new Stream(arr);
                setTimeout(doParse, 0);
            },
            set_frame_offset: setFrameOffset
        };
    };

    return SuperGif;
	
}));





// *** *** *** *** FEATHERLIGHT LIGHTBOX *** *** *** *** //
/**
 * Featherlight - ultra slim jQuery lightbox
 * Version 1.7.13 - http://noelboss.github.io/featherlight/
 *
 * Copyright 2018, Noël Raoul Bossart (http://www.noelboss.com)
 * MIT Licensed.
**/
(function($) {
	"use strict";

	if('undefined' === typeof $) {
		if('console' in window){ window.console.info('Too much lightness, Featherlight needs jQuery.'); }
		return;
	}
	if($.fn.jquery.match(/-ajax/)) {
		if('console' in window){ window.console.info('Featherlight needs regular jQuery, not the slim version.'); }
		return;
	}
	/* Featherlight is exported as $.featherlight.
	   It is a function used to open a featherlight lightbox.

	   [tech]
	   Featherlight uses prototype inheritance.
	   Each opened lightbox will have a corresponding object.
	   That object may have some attributes that override the
	   prototype's.
	   Extensions created with Featherlight.extend will have their
	   own prototype that inherits from Featherlight's prototype,
	   thus attributes can be overriden either at the object level,
	   or at the extension level.
	   To create callbacks that chain themselves instead of overriding,
	   use chainCallbacks.
	   For those familiar with CoffeeScript, this correspond to
	   Featherlight being a class and the Gallery being a class
	   extending Featherlight.
	   The chainCallbacks is used since we don't have access to
	   CoffeeScript's `super`.
	*/

	function Featherlight($content, config) {
		if(this instanceof Featherlight) {  /* called with new */
			this.id = Featherlight.id++;
			this.setup($content, config);
			this.chainCallbacks(Featherlight._callbackChain);
		} else {
			var fl = new Featherlight($content, config);
			fl.open();
			return fl;
		}
	}

	var opened = [],
		pruneOpened = function(remove) {
			opened = $.grep(opened, function(fl) {
				return fl !== remove && fl.$instance.closest('body').length > 0;
			} );
			return opened;
		};

	// Removes keys of `set` from `obj` and returns the removed key/values.
	function slice(obj, set) {
		var r = {};
		for (var key in obj) {
			if (key in set) {
				r[key] = obj[key];
				delete obj[key];
			}
		}
		return r;
	}

	// NOTE: List of available [iframe attributes](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe).
	var iFrameAttributeSet = {
		allow: 1, allowfullscreen: 1, frameborder: 1, height: 1, longdesc: 1, marginheight: 1, marginwidth: 1,
		mozallowfullscreen: 1, name: 1, referrerpolicy: 1, sandbox: 1, scrolling: 1, src: 1, srcdoc: 1, style: 1,
		webkitallowfullscreen: 1, width: 1
	};

	// Converts camelCased attributes to dasherized versions for given prefix:
	//   parseAttrs({hello: 1, hellFrozeOver: 2}, 'hell') => {froze-over: 2}
	function parseAttrs(obj, prefix) {
		var attrs = {},
			regex = new RegExp('^' + prefix + '([A-Z])(.*)');
		for (var key in obj) {
			var match = key.match(regex);
			if (match) {
				var dasherized = (match[1] + match[2].replace(/([A-Z])/g, '-$1')).toLowerCase();
				attrs[dasherized] = obj[key];
			}
		}
		return attrs;
	}

	/* document wide key handler */
	var eventMap = { keyup: 'onKeyUp', resize: 'onResize' };

	var globalEventHandler = function(event) {
		$.each(Featherlight.opened().reverse(), function() {
			if (!event.isDefaultPrevented()) {
				if (false === this[eventMap[event.type]](event)) {
					event.preventDefault(); event.stopPropagation(); return false;
			  }
			}
		});
	};

	var toggleGlobalEvents = function(set) {
			if(set !== Featherlight._globalHandlerInstalled) {
				Featherlight._globalHandlerInstalled = set;
				var events = $.map(eventMap, function(_, name) { return name+'.'+Featherlight.prototype.namespace; } ).join(' ');
				$(window)[set ? 'on' : 'off'](events, globalEventHandler);
			}
		};

	Featherlight.prototype = {
		constructor: Featherlight,
		/*** defaults ***/
		/* extend featherlight with defaults and methods */
		namespace:      'featherlight',        /* Name of the events and css class prefix */
		targetAttr:     'data-featherlight',   /* Attribute of the triggered element that contains the selector to the lightbox content */
		variant:        null,                  /* Class that will be added to change look of the lightbox */
		resetCss:       false,                 /* Reset all css */
		background:     null,                  /* Custom DOM for the background, wrapper and the closebutton */
		openTrigger:    'click',               /* Event that triggers the lightbox */
		closeTrigger:   'click',               /* Event that triggers the closing of the lightbox */
		filter:         null,                  /* Selector to filter events. Think $(...).on('click', filter, eventHandler) */
		root:           'body',                /* Where to append featherlights */
		openSpeed:      250,                   /* Duration of opening animation */
		closeSpeed:     250,                   /* Duration of closing animation */
		closeOnClick:   'background',          /* Close lightbox on click ('background', 'anywhere' or false) */
		closeOnEsc:     true,                  /* Close lightbox when pressing esc */
		closeIcon:      '&#10005;',            /* Close icon */
		loading:        '',                    /* Content to show while initial content is loading */
		persist:        false,                 /* If set, the content will persist and will be shown again when opened again. 'shared' is a special value when binding multiple elements for them to share the same content */
		otherClose:     null,                  /* Selector for alternate close buttons (e.g. "a.close") */
		beforeOpen:     $.noop,                /* Called before open. can return false to prevent opening of lightbox. Gets event as parameter, this contains all data */
		beforeContent:  $.noop,                /* Called when content is loaded. Gets event as parameter, this contains all data */
		beforeClose:    $.noop,                /* Called before close. can return false to prevent opening of lightbox. Gets event as parameter, this contains all data */
		afterOpen:      $.noop,                /* Called after open. Gets event as parameter, this contains all data */
		afterContent:   $.noop,                /* Called after content is ready and has been set. Gets event as parameter, this contains all data */
		afterClose:     $.noop,                /* Called after close. Gets event as parameter, this contains all data */
		onKeyUp:        $.noop,                /* Called on key up for the frontmost featherlight */
		onResize:       $.noop,                /* Called after new content and when a window is resized */
		type:           null,                  /* Specify type of lightbox. If unset, it will check for the targetAttrs value. */
		contentFilters: ['jquery', 'image', 'gif', 'html', 'ajax', 'iframe', 'text'], /* List of content filters to use to determine the content */

		/*** methods ***/
		/* setup iterates over a single instance of featherlight and prepares the background and binds the events */
		setup: function(target, config){
			/* all arguments are optional */
			if (typeof target === 'object' && target instanceof $ === false && !config) {
				config = target;
				target = undefined;
			}

			var self = $.extend(this, config, {target: target}),
				css = !self.resetCss ? self.namespace : self.namespace+'-reset', /* by adding -reset to the classname, we reset all the default css */
				$background = $(self.background || [
					'<div class="'+css+'-loading '+css+'">',
						'<div class="'+css+'-content">',
							'<button class="'+css+'-close-icon '+ self.namespace + '-close" aria-label="Close">',
								self.closeIcon,
							'</button>',
							'<div class="'+self.namespace+'-inner">' + self.loading + '</div>',
						'</div>',
					'</div>'].join('')),
				closeButtonSelector = '.'+self.namespace+'-close' + (self.otherClose ? ',' + self.otherClose : '');

			self.$instance = $background.clone().addClass(self.variant); /* clone DOM for the background, wrapper and the close button */

			/* close when click on background/anywhere/null or closebox */
			self.$instance.on(self.closeTrigger+'.'+self.namespace, function(event) {
				if(event.isDefaultPrevented()) {
					return;
				}
				var $target = $(event.target);
				if( ('background' === self.closeOnClick  && $target.is('.'+self.namespace))
					|| 'anywhere' === self.closeOnClick
					|| $target.closest(closeButtonSelector).length ){
					self.close(event);
					event.preventDefault();
				}
			});

			return this;
		},

		/* this method prepares the content and converts it into a jQuery object or a promise */
		getContent: function(){
			if(this.persist !== false && this.$content) {
				return this.$content;
			}
			var self = this,
				filters = this.constructor.contentFilters,
				readTargetAttr = function(name){ return self.$currentTarget && self.$currentTarget.attr(name); },
				targetValue = readTargetAttr(self.targetAttr),
				data = self.target || targetValue || '';

			/* Find which filter applies */
			var filter = filters[self.type]; /* check explicit type like {type: 'image'} */

			/* check explicit type like data-featherlight="image" */
			if(!filter && data in filters) {
				filter = filters[data];
				data = self.target && targetValue;
			}
			data = data || readTargetAttr('href') || '';

			/* check explicity type & content like {image: 'photo.jpg'} */
			if(!filter) {
				for(var filterName in filters) {
					if(self[filterName]) {
						filter = filters[filterName];
						data = self[filterName];
					}
				}
			}

			/* otherwise it's implicit, run checks */
			if(!filter) {
				var target = data;
				data = null;
				$.each(self.contentFilters, function() {
					filter = filters[this];
					if(filter.test)  {
						data = filter.test(target);
					}
					if(!data && filter.regex && target.match && target.match(filter.regex)) {
						data = target;
					}
					return !data;
				});
				if(!data) {
					if('console' in window){ window.console.error('Featherlight: no content filter found ' + (target ? ' for "' + target + '"' : ' (no target specified)')); }
					return false;
				}
			}
			/* Process it */
			return filter.process.call(self, data);
		},

		/* sets the content of $instance to $content */
		setContent: function($content){
      this.$instance.removeClass(this.namespace+'-loading');

      /* we need a special class for the iframe */
      this.$instance.toggleClass(this.namespace+'-iframe', $content.is('iframe'));

      /* replace content by appending to existing one before it is removed
         this insures that featherlight-inner remain at the same relative
         position to any other items added to featherlight-content */
      this.$instance.find('.'+this.namespace+'-inner')
        .not($content)                /* excluded new content, important if persisted */
        .slice(1).remove().end()      /* In the unexpected event where there are many inner elements, remove all but the first one */
        .replaceWith($.contains(this.$instance[0], $content[0]) ? '' : $content);

      this.$content = $content.addClass(this.namespace+'-inner');

      return this;
		},

		/* opens the lightbox. "this" contains $instance with the lightbox, and with the config.
			Returns a promise that is resolved after is successfully opened. */
		open: function(event){
			var self = this;
			self.$instance.hide().appendTo(self.root);
			if((!event || !event.isDefaultPrevented())
				&& self.beforeOpen(event) !== false) {

				if(event){
					event.preventDefault();
				}
				var $content = self.getContent();

				if($content) {
					opened.push(self);

					toggleGlobalEvents(true);

					self.$instance.fadeIn(self.openSpeed);
					self.beforeContent(event);

					/* Set content and show */
					return $.when($content)
						.always(function($content){
							self.setContent($content);
							self.afterContent(event);
						})
						.then(self.$instance.promise())
						/* Call afterOpen after fadeIn is done */
						.done(function(){ self.afterOpen(event); });
				}
			}
			self.$instance.detach();
			return $.Deferred().reject().promise();
		},

		/* closes the lightbox. "this" contains $instance with the lightbox, and with the config
			returns a promise, resolved after the lightbox is successfully closed. */
		close: function(event){
			var self = this,
				deferred = $.Deferred();

			if(self.beforeClose(event) === false) {
				deferred.reject();
			} else {

				if (0 === pruneOpened(self).length) {
					toggleGlobalEvents(false);
				}

				self.$instance.fadeOut(self.closeSpeed,function(){
					self.$instance.detach();
					self.afterClose(event);
					deferred.resolve();
				});
			}
			return deferred.promise();
		},

		/*resizes the content so it fits in visible area and keeps the same aspect ratio.
				Does nothing if either the width or the height is not specified.
				Called automatically on window resize.
				Override if you want different behavior.*/
		resize: function(w, h) {
			/*if (w && h) {
				// Reset apparent image size first so container grows 
				this.$content.css('width', '').css('height', '');
				// Calculate the worst ratio so that dimensions fit 
				 // Note: -1 to avoid rounding errors 
				var ratio = Math.max(
					w  / (this.$content.parent().width()-1),
					h / (this.$content.parent().height()-1));
				// Resize content 
				if (ratio > 1) {
					ratio = h / Math.floor(h / ratio); // Round ratio down so height calc works 
					this.$content.css('width', '' + w / ratio + 'px').css('height', '' + h / ratio + 'px');
				}
			}*/
		},

		/* Utility function to chain callbacks
		   [Warning: guru-level]
		   Used be extensions that want to let users specify callbacks but
		   also need themselves to use the callbacks.
		   The argument 'chain' has callback names as keys and function(super, event)
		   as values. That function is meant to call `super` at some point.
		*/
		chainCallbacks: function(chain) {
			for (var name in chain) {
				this[name] = $.proxy(chain[name], this, $.proxy(this[name], this));
			}
		}
	};
	

	$.extend(Featherlight, {
		id: 0,                                    /* Used to id single featherlight instances */
		autoBind:       '[data-featherlight]',    /* Will automatically bind elements matching this selector. Clear or set before onReady */
		defaults:       Featherlight.prototype,   /* You can access and override all defaults using $.featherlight.defaults, which is just a synonym for $.featherlight.prototype */
		/* Contains the logic to determine content */
		contentFilters: {
			jquery: {
				regex: /^[#.]\w/,         /* Anything that starts with a class name or identifiers */
				test: function(elem)    { return elem instanceof $ && elem; },
				process: function(elem) { return this.persist !== false ? $(elem) : $(elem).clone(true); }
			},
			image: {
				regex: /\.(png|jpg|jpeg|tiff?|bmp|svg)(\?\S*)?$/i,
				process: function(url)  {
					var self = this,
						deferred = $.Deferred(),
						img = new Image(), 
						$img = $('<img src="'+url+'" alt="" class="'+self.namespace+'-image" />');

					img.onload  = function() {
						/* Store naturalWidth & height for IE8 */
						$img.naturalWidth = img.width; $img.naturalHeight = img.height;
						deferred.resolve( $img );
					};
					img.onerror = function() { deferred.reject($img); };
					img.src = url;
					return deferred.promise();

				}
			},
			gif: {
				regex: /\.(gif)(\?\S*)?$/i,
				process: function(url)  {
					var self = this,
						deferred = $.Deferred(),
						img = new Image(), // contains absolutely gross libgif hacking, lol metal //
						$img = $('<img id="example1" src="'+url+'" rel:animated_src="'+url+'" alt="" class="'+self.namespace+'-image" />'+'<script type="text/javascript">'+'var sup1 = new SuperGif({ gif: document.getElementById('+'"example1"'+') } );'+'sup1.load();'+'</script>'+'<div class="playbackcontainer"><div class="playbackcontrols"><a class="playbackbutton" href ="javascript:;" onmousedown='+'"sup1.pause(); sup1.move_relative(-1); return false;">Back</a>'+'<a class="playbackbutton" href ="javascript:;" onmousedown='+'"sup1.pause(); sup1.move_relative(1); return false;">Forward</a></div><p style="font-size:85%;">The animation must fully load before you use playback controls or things will get weird (the red bar).</p><p style="font-size:85%;"><a class="featherlight-close" href="javascript:;" aria-label="Close">Close</a> and re-open this pop-up to refresh.</p></div>'
						);

					img.onload  = function() {
						/* Store naturalWidth & height for IE8 */
						$img.naturalWidth = img.width; $img.naturalHeight = img.height;
						deferred.resolve( $img );
					};
					img.onerror = function() { deferred.reject($img); };
					img.src = url;
					return deferred.promise();

				}
			},
			html: {
				regex: /^\s*<[\w!][^<]*>/, /* Anything that starts with some kind of valid tag */
				process: function(html) { return $(html); }
			},
			ajax: {
				regex: /./,            /* At this point, any content is assumed to be an URL */
				process: function(url)  {
					var self = this,
						deferred = $.Deferred();
					/* we are using load so one can specify a target with: url.html #targetelement */
					var $container = $('<div></div>').load(url, function(response, status){
						if ( status !== "error" ) {
							deferred.resolve($container.contents());
						}
						deferred.fail();
					});
					return deferred.promise();
				}
			},
			iframe: {
				process: function(url) {
					var deferred = new $.Deferred();
					var $content = $('<iframe/>');
					var css = parseAttrs(this, 'iframe');
					var attrs = slice(css, iFrameAttributeSet);
					$content.hide()
						.attr('src', url)
						.attr(attrs)
						.css(css)
						.on('load', function() { deferred.resolve($content.show()); })
						// We can't move an <iframe> and avoid reloading it,
						// so let's put it in place ourselves right now:
						.appendTo(this.$instance.find('.' + this.namespace + '-content'));
					return deferred.promise();
				}
			},
			text: {
				process: function(text) { return $('<div>', {text: text}); }
			}
		},

		functionAttributes: ['beforeOpen', 'afterOpen', 'beforeContent', 'afterContent', 'beforeClose', 'afterClose'],

		/*** class methods ***/
		/* read element's attributes starting with data-featherlight- */
		readElementConfig: function(element, namespace) {
			var Klass = this,
				regexp = new RegExp('^data-' + namespace + '-(.*)'),
				config = {};
			if (element && element.attributes) {
				$.each(element.attributes, function(){
					var match = this.name.match(regexp);
					if (match) {
						var val = this.value,
							name = $.camelCase(match[1]);
						if ($.inArray(name, Klass.functionAttributes) >= 0) {  /* jshint -W054 */
							val = new Function(val);                           /* jshint +W054 */
						} else {
							try { val = JSON.parse(val); }
							catch(e) {}
						}
						config[name] = val;
					}
				});
			}
			return config;
		},

		/* Used to create a Featherlight extension
		   [Warning: guru-level]
		   Creates the extension's prototype that in turn
		   inherits Featherlight's prototype.
		   Could be used to extend an extension too...
		   This is pretty high level wizardy, it comes pretty much straight
		   from CoffeeScript and won't teach you anything about Featherlight
		   as it's not really specific to this library.
		   My suggestion: move along and keep your sanity.
		*/
		extend: function(child, defaults) {
			/* Setup class hierarchy, adapted from CoffeeScript */
			var Ctor = function(){ this.constructor = child; };
			Ctor.prototype = this.prototype;
			child.prototype = new Ctor();
			child.__super__ = this.prototype;
			/* Copy class methods & attributes */
			$.extend(child, this, defaults);
			child.defaults = child.prototype;
			return child;
		},

		attach: function($source, $content, config) {
			var Klass = this;
			if (typeof $content === 'object' && $content instanceof $ === false && !config) {
				config = $content;
				$content = undefined;
			}
			/* make a copy */
			config = $.extend({}, config);

			/* Only for openTrigger, filter & namespace... */
			var namespace = config.namespace || Klass.defaults.namespace,
				tempConfig = $.extend({}, Klass.defaults, Klass.readElementConfig($source[0], namespace), config),
				sharedPersist;
			var handler = function(event) {
				var $target = $(event.currentTarget);
				/* ... since we might as well compute the config on the actual target */
				var elemConfig = $.extend(
					{$source: $source, $currentTarget: $target},
					Klass.readElementConfig($source[0], tempConfig.namespace),
					Klass.readElementConfig(event.currentTarget, tempConfig.namespace),
					config);
				var fl = sharedPersist || $target.data('featherlight-persisted') || new Klass($content, elemConfig);
				if(fl.persist === 'shared') {
					sharedPersist = fl;
				} else if(fl.persist !== false) {
					$target.data('featherlight-persisted', fl);
				}
				if (elemConfig.$currentTarget.blur) {
					elemConfig.$currentTarget.blur(); // Otherwise 'enter' key might trigger the dialog again
				}
				fl.open(event);
			};

			$source.on(tempConfig.openTrigger+'.'+tempConfig.namespace, tempConfig.filter, handler);

			return {filter: tempConfig.filter, handler: handler};
		},

		current: function() {
			var all = this.opened();
			return all[all.length - 1] || null;
		},

		opened: function() {
			var klass = this;
			pruneOpened();
			return $.grep(opened, function(fl) { return fl instanceof klass; } );
		},

		close: function(event) {
			var cur = this.current();
			if(cur) { return cur.close(event); }
		},

		/* Does the auto binding on startup.
		   Meant only to be used by Featherlight and its extensions
		*/
		_onReady: function() {
			var Klass = this;
			if(Klass.autoBind){
				var $autobound = $(Klass.autoBind);
				/* Bind existing elements */
				$autobound.each(function(){
					Klass.attach($(this));
				});
				/* If a click propagates to the document level, then we have an item that was added later on */
				$(document).on('click', Klass.autoBind, function(evt) {
					if (evt.isDefaultPrevented()) {
						return;
					}
					var $cur = $(evt.currentTarget);
					var len = $autobound.length;
					$autobound = $autobound.add($cur);
					if(len === $autobound.length) {
						return; /* already bound */
					}
					/* Bind featherlight */
					var data = Klass.attach($cur);
					/* Dispatch event directly */
					if (!data.filter || $(evt.target).parentsUntil($cur, data.filter).length > 0) {
						data.handler(evt);
					}
				});
			}
		},

		/* Featherlight uses the onKeyUp callback to intercept the escape key.
		   Private to Featherlight.
		*/
		_callbackChain: {
			onKeyUp: function(_super, event){
				if(27 === event.keyCode) {
					if (this.closeOnEsc) {
						$.featherlight.close(event);
					}
					return false;
				} else {
					return _super(event);
				}
			},

			beforeOpen: function(_super, event) {
				// Used to disable scrolling
				$(document.documentElement).addClass('with-featherlight');

				// Remember focus:
				this._previouslyActive = document.activeElement;

				// Disable tabbing:
				// See http://stackoverflow.com/questions/1599660/which-html-elements-can-receive-focus
				this._$previouslyTabbable = $("a, input, select, textarea, iframe, button, iframe, [contentEditable=true]")
					.not('[tabindex]')
					.not(this.$instance.find('button'));

				this._$previouslyWithTabIndex = $('[tabindex]').not('[tabindex="-1"]');
				this._previousWithTabIndices = this._$previouslyWithTabIndex.map(function(_i, elem) {
					return $(elem).attr('tabindex');
				});

				this._$previouslyWithTabIndex.add(this._$previouslyTabbable).attr('tabindex', -1);

				if (document.activeElement.blur) {
					document.activeElement.blur();
				}
				return _super(event);
			},

			afterClose: function(_super, event) {
				var r = _super(event);
				// Restore focus
				var self = this;
				this._$previouslyTabbable.removeAttr('tabindex');
				this._$previouslyWithTabIndex.each(function(i, elem) {
					$(elem).attr('tabindex', self._previousWithTabIndices[i]);
				});
				this._previouslyActive.focus();
				// Restore scroll
				if(Featherlight.opened().length === 0) {
					$(document.documentElement).removeClass('with-featherlight');
				}
				return r;
			},

			onResize: function(_super, event){
				this.resize(this.$content.naturalWidth, this.$content.naturalHeight);
				return _super(event);
			},

			afterContent: function(_super, event){
				var r = _super(event);
				this.$instance.find('[autofocus]:not([disabled])').focus();
				this.onResize(event);
				return r;
			}
		}
	});

	$.featherlight = Featherlight;

	/* bind jQuery elements to trigger featherlight */
	$.fn.featherlight = function($content, config) {
		Featherlight.attach(this, $content, config);
		return this;
	};

	/* bind featherlight on ready if config autoBind is set */
	$(document).ready(function(){ Featherlight._onReady(); });
}(jQuery));

/* Automatically create the <img /> for hitbox images for any anchor that has a data-featherlight attribute -- Metal */
	$(document).ready(function(){
		$('.hitboximg').html(function () {
		return  '<img alt="Hitbox Image" data-src="' + $(this).attr('data-featherlight') + '" />'
		});
	});
