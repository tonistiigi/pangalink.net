var config = require("../config/" + (process.env.NODE_ENV || "development") + ".json"),
    tools = require("./tools"),
    util = require("util"),
    db = require("./db"),
    encoding = require("encoding"),
    banks = require("./banks.json"),
    crypto = require("crypto"),
    bankObjects = {
        "ipizza": require("./banks/ipizza"),
        "solo": require("./banks/solo"),
        "ec": require("./banks/ec")
    };

module.exports.serveBanklink = serveBanklink;
module.exports.handlePayment = handlePayment;

module.exports.signatureOrder = function(bankType){
    return bankObjects[bankType] && bankObjects[bankType].signatureOrder || [];
}

function serveBanklink(req, res){
    var errors = [], warnings = [];

    if(req.method != "POST"){
        errors.push(util.format("Lubatud on ainult POST päringud. Kontrolli kas kasutad õiget domeeni %s või toimub vahepeal ümbersuunamine."), config.hostname);
        return serveErrors(req, res, errors);
    }

    if(!req.banklink){
        errors.push("Päringu sisust ei leitud pangalingi andmeid");
        return serveErrors(req, res, errors);
    }

    var project = new bankObjects[req.banklink.type](req.banklink.bank, req.body);

    project.validateClient(function(err, data){
        errors = errors.concat(data.errors || []);
        warnings = warnings.concat(data.warnings || []);

        if(err){
            errors = errors.concat(err.message || []);
            return logPayment(project, "ERROR", req, res, {errors: errors, warnings: warnings}, serveErrors.bind(this, req, res, errors, warnings));
        }
        if(!data.success){
            return logPayment(project, "ERROR", req, res, data, serveErrors.bind(this, req, res, errors, warnings));
        }
        project.validateRequest(function(err, data){
            if(err){
                return serveErrors(req, res, [err.message || err]);
            }

            errors = errors.concat(data.errors || []);
            warnings = warnings.concat(data.warnings || []);

            if(!data.success){
                return logPayment(project, "ERROR", req, res, {errors: errors, warnings: warnings}, serveErrors.bind(this, req, res, errors, warnings));
            }

            project.validateSignature(function(err, data){
                if(err){
                    return serveErrors(req, res, errors.concat(err.message || err));
                }

                errors = errors.concat(data.errors || []);
                warnings = warnings.concat(data.warnings || []);

                if(!data.success){
                    return logPayment(project, "ERROR", req, res, {errors: errors, warnings: warnings}, serveErrors.bind(this, req, res, errors, warnings));
                }

                data.errors = errors;
                data.warnings = warnings;

                logPayment(project, "IN PROCESS", req, res, data, function(err, id){
                    if(err){
                        res.send(err.message);
                    }else{
                        res.redirect("/preview/"+id);
                    }
                });
            });

        });

    });
}

function logPayment(project, state, req, res, data, callback){
    var uid;
    if(!project || !(uid = project.getUid())){
        return callback(null);
    }

    db.findOne("project", {uid: uid}, function(err, record){
        if(err){
            return callback(err);
        }

        if(!record){
            return callback(null, false);
        }

        var paymentRecord = {
            project: (record._id || "").toString(),

            date: new Date(),

            state: state,

            done: state == "ERROR",

            bank: req.banklink.type,

            charset: project.getCharset(),

            language: project.getLanguage(),

            type: project.getType(),

            amount: project.getAmount(),

            referenceCode: project.getReferenceCode(),

            receiverName: project.getReceiverName(),

            receiverAccount: project.getReceiverAccount(),

            message: project.getMessage(),

            currency: project.getCurrency(),

            successTarget: project.getSuccessTarget(),
            cancelTarget: project.getCancelTarget(),
            rejectTarget: project.getRejectTarget(),

            editSenderName: project.editSenderName(),
            showSenderName: project.showSenderName(),
            editSenderAccount: project.editSenderAccount(),
            showSenderAccount: project.showSenderAccount(),

            showReceiverName: project.showReceiverName(),
            showReceiverAccount: project.showReceiverAccount(),

            senderName: req.body.PANGALINK_NAME || "Tõõger Leõpäöld",
            senderAccount: req.body.PANGALINK_ACCOUNT || tools.generateExampleAccountNr(banks[record.bank].accountNrPrefix, banks[record.bank].accountNrLength, crypto.randomBytes(20).toString("base64")),

            url: req.url,

            method: req.method,

            errors: data.errors && data.errors.length && data.errors || false,

            warnings: data.warnings && data.warnings.length && data.warnings || false,

            headers: Object.keys(req.headers).map(function(key){
                var value = (req.headers[key] || "").toString().trim();
                if(value.length > 100 * 1024){
                    value = value.substr(0, 100 * 1024) + " ...";
                }
                return {key: key, value: value};
            }),

            fields: Object.keys(req.body).map(function(key){
                var value = (req.body[key] || "").toString().trim();
                if(value.length > 100 * 1024){
                    value = value.substr(0, 100 * 1024)+" ...";
                }
                return {key: key, value: value};
            }),

            hash: project.getSourceHash(),

            body: req.rawBody.toString("base64")
        };

        db.save("payment", paymentRecord, function(err, id){
            if(err){
                return callback(err);
            }

            record.updatedDate = paymentRecord.date;
            db.save("project", record, function(){
                return callback(null, id);
            });
        });
    });
}


function serveErrors(req, res, errors, warnings, err, id){
    return res.render("banklink/error", {

        errors: errors && errors.length && errors || false,
        warnings: warnings && warnings.length && warnings || false,
        url: req.url,
        id: id || false,
        method: req.method,

        headers: Object.keys(req.headers).map(function(key){
            var value = (req.headers[key] || "").toString().trim();
            if(value.length > 4096){
                value = value.substr(0, 4096) + " ...";
            }
            return {key: key, value: value};
        }),

        fields: Object.keys(req.body).map(function(key){
            var value = (req.body[key] || "").toString().trim();
            if(value.length > 4096){
                value = value.substr(0, 4096)+" ...";
            }
            return {key: key, value: value};
        }),

        body: (req.rawBody || "").toString("binary")
    });
}

function handlePayment(payment, project, callback){

    bankObjects[payment.bank].generateForm(payment, project, function(err, response){
        if(!payment.charset.match(/^utf[\-_]?8/i)){
            if(payment.responseFields){
                Object.keys(payment.responseFields).forEach(function(key){
                    payment.responseFields[key] = encoding.convert(encoding.convert(payment.responseFields[key], payment.charset), "utf-8", payment.charset).toString("utf-8");
                });
            }
            if(payment.responseHash){
                payment.responseHash = encoding.convert(encoding.convert(payment.responseHash, payment.charset), "utf-8", payment.charset).toString("utf-8");
            }
        }
        return callback(err, response);
    });

}
