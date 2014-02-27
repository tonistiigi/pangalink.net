"use strict";

var encodinglib = require("encoding");

module.exports = function(req, res, next){
    // proxy

    var write = res.write,
        end = res.end,
        buffer,
        bufferLen;

    res.write = function(chunk, encoding){
        if (!this.headerSent) this._implicitHeader();
        if(!buffer){
            write.call(res, chunk, encoding);
        }else{
            if(encoding && typeof chunk == "string"){
                chunk = new Buffer(chunk, encoding);
            }
            buffer.push(chunk);
            bufferLen += chunk.length;
        }
    };

    res.end = function(chunk, encoding){
        if (chunk) this.write(chunk, encoding);

        if(buffer){
            write.call(res, encodinglib.convert(Buffer.concat(buffer, bufferLen), res.forceCharset));
        }

        return end.call(res);
    };

    res.on("header", function(){
        // head
        if (req.method == "HEAD") return;

        if(res.forceCharset && !res.forceCharset.match(/^utf[\-_]?8$/i)){
            buffer = [];
            bufferLen = 0;
        }
    });

    next();
};
