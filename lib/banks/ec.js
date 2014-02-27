"use strict";

var config = require("../../config/" + (process.env.NODE_ENV || "development") + ".json"),
    util = require("util"),
    banks = require("../banks"),
    tools = require("../tools"),
    db = require("../db"),
    crypto = require("crypto"),
    moment = require("moment"),
    fetchUrl = require("fetch").fetchUrl,
    querystring = require("querystring"),
    urllib = require("url"),
    redis = require("redis"),
    redisClient = redis.createClient(config.redis.port, config.redis.host);

module.exports = IPAYServlet;

function IPAYServlet(bank, fields, charset){
    this.bank = (typeof bank == "string" ? banks[bank] || banks.ec || {} : bank) || {};
    this.fields = fields || {};

    this.normalizeValues();

    this.version = IPAYServlet.detectVersion(this.bank, this.fields);
    this.language = IPAYServlet.detectLanguage(this.bank, this.fields);
    this.charset = charset || IPAYServlet.detectCharset(this.bank, this.fields);
}

IPAYServlet.samplePayment = function(project, callback){
    var bank = banks[project.bank] || banks.ipizza,
        charsetValue, charsetKey;

    charsetValue = ((bank.allowedCharsets || []).indexOf("UTF-8") >= 0 ? "UTF-8" : (bank.allowedCharsets || [])[0] || "ISO-8859-1").toLowerCase();
    charsetKey = bank.charset || "charEncoding";

    var testFields = {
            "action": "gaf",
            "ver": "004",
            "id": project.uid,
            "ecuno": "1392644629",
            "eamount": "1336",
            "cur": "EUR",
            "datetime": "20140217154349",
            "feedBackUrl": project.ecUrl,
            "delivery": "S",
            "lang": "en"
        };

    if(charsetKey){
        testFields[charsetKey] = charsetValue;
    }

    var payment = new IPAYServlet(project.bank, testFields, charsetValue);
    payment.record = project;
    payment.signClient(function(err){
        if(err){
            return callback(err);
        }
        callback(null, payment, charsetValue);
    });
};

IPAYServlet.detectVersion = function(bank, fields){
    return fields.ver || "002";
};

IPAYServlet.detectLanguage = function(bank, fields){
    bank = (typeof bank == "string" ? banks[bank] || banks.ec || {} : bank) || {};

    var language = IPAYServlet.languageCodes[(fields.lang || "ET").toUpperCase().trim()];
    if(IPAYServlet.languages.indexOf(language) < 0){
        language = IPAYServlet.defaultLanguage;
    }

    return language;
};

IPAYServlet.detectCharset = function(bank, fields){
    var version = IPAYServlet.detectVersion(bank, fields);

    var defaultCharset = bank.defaultCharset || config.ec.defaultCharset;

    if(version == "004"){
        return fields.charEncoding || defaultCharset;
    }

    return defaultCharset;
};

IPAYServlet.languages = ["ET", "EN", "FI", "DE"];
IPAYServlet.languageCodes = {
    "ET": "EST",
    "EN": "ENG",
    "FI":"FIN",
    "DE": "GER"
};

IPAYServlet.defaultLanguage = "EST";

IPAYServlet.actionFields = {

    "gaf":[
        "action",
        "ver",
        "id",
        "ecuno",
        "eamount",
        "cur",
        "datetime",
        "mac",
        "lang",
        "charEncoding",
        "feedBackUrl",
        "delivery"
    ],
    "afb":[
        "action",
        'ver',
        'id',
        'ecuno',
        'receipt_no',
        'eamount',
        'cur',
        'respcode',
        'datetime',
        'msgdata',
        'actiontext',
        "mac",
        "charEncoding",
        "auto"
    ]
};

IPAYServlet.signatureOrder = {

    "002":{
        "gaf":[
            "ver",
            "id",
            "ecuno",
            "eamount",
            "cur",
            "datetime"
        ],
        "afb":[
            'ver',
            'id',
            'ecuno',
            'receipt_no',
            'eamount',
            'cur',
            'respcode',
            'datetime',
            'msgdata',
            'actiontext'
        ]
    },

    "004":{
        "gaf":[
            "ver",
            "id",
            "ecuno",
            "eamount",
            "cur",
            "datetime",
            "feedBackUrl",
            "delivery"
        ],
        "afb":[
            'ver',
            'id',
            'ecuno',
            'receipt_no',
            'eamount',
            'cur',
            'respcode',
            'datetime',
            'msgdata',
            'actiontext'
        ]
    }
};

IPAYServlet.signatureLength = {
    'action':     -3,
    'ver':         3,
    'id':        -10,
    'ecuno':      12,
    'eamount':    12,
    'cur':        -3,
    'lang':       -2,
    'datetime':  -14,
    'receipt_no':  6,
    'respcode':    3,
    'msgdata':   -40,
    'actiontext':-40,
    'charEncoding':-16,
    'feedBackUrl': -128,
    'delivery':   -1,
    "auto":       -1
};

// ++ kohustuslikud meetodid

IPAYServlet.prototype.validateClient = function(callback){

    db.findOne("project", {uid: this.fields.id}, (function(err, record){
        if(err){
            return callback(err);
        }

        if(!record){
            return callback(null, {success: false, errors: [
                {field: "id", value: (this.fields.id || "").toString(),
                error: "Sellise kliendi tunnusega makselahendust ei leitud. Juhul kui sertifikaat on aegunud, tuleks see uuesti genereerida"}], warnings: false});
        }

        if(this.bank.key != record.bank){
            return callback(null, {success: false, errors: [
                {field: "id", value: (this.fields.id || "").toString(),
                error: util.format("Valitud kliendi tunnus kehtib ainult '%s' makselahenduse jaoks, hetkel on valitud '%s'", banks[record.bank].name, this.bank.name)}], warnings: false});
        }

        this.record = record;

        callback(null, {
            success: true,
            errors: false,
            warnings: false
        });

    }).bind(this));
};

IPAYServlet.prototype.validateSignature = function(callback){
    this.calculateHash();

    tools.opensslVerify(
        this.sourceHash,
        this.fields.mac,
        this.record.userCertificate.certificate.toString("utf-8").trim(),
        this.charset,
        "hex",
        (function(err, success){
            if(err){
                return callback(err);
            }
            callback(null, {
                success: !!success,
                errors: !success?[
                        {field: "mac",
                        error: util.format("Allkirja parameetri %s valideerimine ebaõnnestus. Makse detailvaatest saad alla laadida PHP skripti, mis genereerib samade andmetega korrektse allkirja.", "mac")}
                    ]:false,
                warnings: false
            });
        }).bind(this));
};

IPAYServlet.prototype.sign = function(callback){
    this.calculateHash();

    tools.opensslSign(
        this.sourceHash,
        this.record.bankCertificate.clientKey.toString("utf-8").trim(),
        this.charset,
        "hex",
        (function(err, signature){
            if(err){
                return callback(err);
            }
            this.fields.mac = signature;
            callback(null, true);
        }).bind(this));
};

IPAYServlet.prototype.signClient = function(callback){
    this.calculateHash();

    tools.opensslSign(
        this.sourceHash,
        this.record.userCertificate.clientKey.toString("utf-8").trim(),
        this.charset,
        "hex",
        (function(err, signature){
            if(err){
                return callback(err);
            }
            this.fields.mac = signature;
            callback(null, true);
        }).bind(this));
};

IPAYServlet.prototype.checkEcuno = function(callback){
    if(!this.fields.id || !this.fields.ecuno){
        // do not raise error here, will fail in the validation phase
        return callback(null, true);
    }
    redisClient.multi().
        select(config.redis.db).
        get("ipay-" + this.fields.id+":"+this.fields.ecuno).
        set("ipay-" + this.fields.id+":"+this.fields.ecuno, 1).
        expire("ipay-" + this.fields.id+":"+this.fields.ecuno, 24 * 3600).
        exec(function(err, replies){
            if(err){
                return callback(err);
            }
            return callback(null, !Number(replies && replies[1]));
        });
};

IPAYServlet.prototype.validateRequest = function(callback){
    var validator = new IPAYServletValidator(this.bank, this.fields);
    validator.validateFields();
    this.errors = validator.errors;
    this.warnings = validator.warnings;

    this.checkEcuno((function(err, success){

        if(err){
            return callback(err);
        }

        if(!success){
            this.warnings.push({
                field: "ecuno",
                value: (this.fields.ecuno || "").toString(),
                warning: util.format("Unikaalse tehingu numbri %s väärtust %s on viimase 24 tunni jooksul juba kasutatud", "ecuno", this.fields.ecuno)
            });
        }

        callback(null, {
            success: !this.errors.length,
            errors: this.errors.length && this.errors || false,
            warnings: this.warnings.length && this.warnings || false
        });

    }).bind(this));
};

IPAYServlet.prototype.getUid = function(){
    return this.fields.id;
};

IPAYServlet.prototype.getCharset = function(){
    return this.charset;
};

IPAYServlet.prototype.getLanguage = function(){
    return tools.languages[this.language] || "et";
};

IPAYServlet.prototype.getSourceHash = function(){
    return this.sourceHash || false;
};

IPAYServlet.prototype.getType = function(){
    return "PAYMENT";
};

IPAYServlet.prototype.getAmount = function(){
    return ((Number(this.fields.eamount) || 0)/100).toString() || "0";
};

IPAYServlet.prototype.getReferenceCode = function(){
    return false;
};

IPAYServlet.prototype.getMessage = function(){
    return false;
};

IPAYServlet.prototype.getCurrency = function(){
    return (this.fields.cur || "EUR").toUpperCase().trim();
};

IPAYServlet.prototype.getReceiverName = function(){
    return false;
};

IPAYServlet.prototype.getReceiverAccount = function(){
    return false;
};

IPAYServlet.prototype.editSenderName = function(){
    return true;
};

IPAYServlet.prototype.showSenderName = function(){
    return false;
};

IPAYServlet.prototype.editSenderAccount = function(){
    return false;
};

IPAYServlet.prototype.showSenderAccount = function(){
    return false;
};

IPAYServlet.prototype.showReceiverName = function(){
    return false;
};

IPAYServlet.prototype.showReceiverAccount = function(){
    return false;
};

IPAYServlet.prototype.getSuccessTarget = function(){
    if(this.version == "004"){
        return this.fields.feedBackUrl || this.record.ecUrl || "";
    }
    return this.record.ecUrl || "";
};

IPAYServlet.prototype.getCancelTarget = function(){
    return this.getSuccessTarget();
};

IPAYServlet.prototype.getRejectTarget = function(){
    return this.getSuccessTarget();
};

// -- kohustuslikud meetodid

IPAYServlet.prototype.calculateHash = function(){
    var list = [], key, value, pad,
        signatureOrders = IPAYServlet.signatureOrder[this.version] && IPAYServlet.signatureOrder[this.version][this.fields.action];

    if(!signatureOrders){
        this.sourceHash = false;
        return;
    }

    for(var i=0, len = signatureOrders.length; i < len; i++){
        key = signatureOrders[i];
        value = String(this.fields[key]);

        pad = IPAYServlet.signatureLength[key] || 0;

        if(pad<0){
            value = value.rpad(pad, " ");
        }else{
            value = value.lpad(pad);
        }

        list.push(value);

    }

    this.sourceHash = list.join("");

    return this.sourceHash;
};

IPAYServlet.prototype.normalizeValues = function(){
    var keys = Object.keys(this.fields);

    for(var i = 0, len = keys.length; i < len; i++){
        if(this.fields[keys[i]] || this.fields[keys[i]]===0){
            this.fields[keys[i]] = (this.fields[keys[i]]).toString().trim();
        }else{
            this.fields[keys[i]] = "";
        }
    }
};

function IPAYServletValidator(bank, fields){
    this.bank = (typeof bank == "string" ? banks[bank] || banks.ec || {} : bank) || {};
    this.fields = fields || {};

    this.version =IPAYServlet.detectVersion(this.bank, this.fields);

    this.errors = [];
    this.warnings = [];
}

IPAYServletValidator.prototype.validateFields = function(){
    var action = (this.fields.action || "").toString(),
        versionResponse,
        actionResponse;

    this.errors = [];
    this.warnings = [];

    versionResponse = this.validate_ver(true);
    if(typeof versionResponse == "string"){
        this.errors.push({field: "ver", value: this.version, error: versionResponse});
        return;
    }

    actionResponse = this.validate_action();
    if(typeof actionResponse == "string"){
        this.errors.push({field: "action", value: action, error: actionResponse});
        return;
    }

    IPAYServlet.actionFields[action].forEach((function(field){
        var response = this["validate_" + field](),
            value = (this.fields[field] || "").toString();
        if(typeof response == "string"){
            this.errors.push({field: field, value: value, error: response});
        }else if(this.bank.fieldLength && 
          this.bank.fieldLength[field] && 
          value.length > this.bank.fieldLength[field]){
            this.warnings.push({
                field: field, 
                value: value,
                warning: util.format("Välja %s pikkus on %s sümbolit, lubatud on %s", field, value.length, this.bank.fieldLength[field])
            });
        }
    }).bind(this));
};

IPAYServletValidator.prototype.validate_ver = function(initial){
    var value = (this.fields.ver || "").toString();

    if(!value){
        return util.format("Protokolli versiooni %s väärtust ei leitud", "action");
    }

    if(!IPAYServlet.signatureOrder[value]){
        return util.format("Protokolli versiooni %s (\"%s\") väärtus peab olema üks järgmistest: %s", "ver", value, Object.keys(IPAYServlet.signatureOrder).join(", "));
    }

    if(initial && value == "002"){
        this.warnings.push({
            field: "ver",
            value: value,
            warning: util.format("Kaardikeskuse versioon 002 on aegunud ning selle asemel tuleks kasutada versiooni 004")
        });
    }

    return true;
};

IPAYServletValidator.prototype.validate_action = function(){
    var value = (this.fields.action || "").toString();

    if(!value){
        return util.format("Teenuskoodi %s väärtust ei leitud", "action");
    }

    if(!IPAYServlet.signatureOrder[this.version][value]){
        return util.format("Teenuskoodi %s (\"%s\") väärtus ei ole toetatud. Kasutada saab järgmisi väärtuseid: ", "action", value, Object.keys(IPAYServlet.signatureOrder[this.version]).join(", "));
    }

    return true;
};

IPAYServletValidator.prototype.validate_id = function(){
    var value = (this.fields.id || "").toString();

    if(!value){
        return util.format("Päringu koostaja tunnus %s peab olema määratud", "id");
    }

    return true;
};

IPAYServletValidator.prototype.validate_ecuno = function(){
    var value = (this.fields.ecuno || "").toString();

    if(!value){
        return util.format('Tehingu unikaalse numbri %s kasutamine on kohustuslik', "ecuno");
    }

    if(Number(value)<100000){
        return util.format('Tehingu unikaalse numbri %s numbriline väärtus peab olema vähemalt 100000', "ecuno");
    }

    if(String(value).length>12){
        return util.format('Tehingu unikaalne number %s on liiga pikk (maksimaalselt 12 numbrikohta)', "ecuno");
    }

    return true;
};


IPAYServletValidator.prototype.validate_eamount = function(){
    var value = (this.fields.eamount || "").toString();

    if(!value){
        return util.format('Tehingu summa %s kasutamine on kohustuslik', "eamount");
    }

    if(!String(value).match(/^\d{1,}$/)){
        return util.format('Makse summa %s peab olema numbriline (täisarv) sendiväärtus', "eamount");
    }

    return true;
};

IPAYServletValidator.prototype.validate_cur = function(){
    var value = (this.fields.cur || "").toString();

    if(!value){
        return util.format('Valuuta %s väärtus on seadmata', "cur");
    }

    if(!value || !value.match(/^[A-Z]{3}$/i)){
        return util.format('Valuuta %s ei ole korrektses formaadis', "cur");
    }

    return true;
};

IPAYServletValidator.prototype.validate_datetime = function(){
    var value = (this.fields.datetime || "").toString();

    if(!value){
        return util.format('Tehingu sooritamise aeg %s on seadmata', "datetime");
    }

    if(value.length != 14 || !String(value).match(/^\d{1,}$/)){
        return util.format('Tehingu sooritamise aeg %s on vigasel kujul, peab olema formaadis "AAAAKKPPTTmmss"', "datetime");
    }

    return true;
};

IPAYServletValidator.prototype.validate_lang = function(){
    var value = (this.fields.lang || "").toString();

    if(value && IPAYServlet.languages.indexOf(value.toUpperCase()) < 0){
        return util.format('Tundmatu keelekoodi %s väärtus', "lang");
    }

    return true;
};

IPAYServletValidator.prototype.validate_mac = function(){
    var value = (this.fields.mac || "").toString();

    if(!value){
        return util.format('Allkirja parameeter %s puudub', "mac");
    }

    if(!value.match(/^[0-9a-f]+$/i)){
        return util.format("Allkirja parameeter %s peab olema HEX formaadis", "mac");
    }

    if(new Buffer(value, "hex").length % 128){
        return util.format("Allkirja parameeter %s on vale pikkusega, väärtus vastab %s bitisele võtmele, lubatud on 1024, 2048 ja 4096 bitised võtmed", "mac", new Buffer(value, "hex").length * 8);
    }

    return true;
};

IPAYServletValidator.prototype.validate_charEncoding = function(){
    var value = (this.fields.charEncoding || "").toString(),
        allowedCharsets = this.bank.allowedCharsets || [this.bank.defaultCharset || config.ec.defaultCharset],
        defaultCharset = this.bank.defaultCharset || config.ec.defaultCharset;

    if(!value){
        return true;
    }

    if(value && this.version == "002"){
        return util.format("Teksti kodeeringu parameetri %s kasutamine ei ole protokolli versiooni %s puhul lubatud", "charEncoding", this.version);
    }

    if(allowedCharsets.indexOf(value.toUpperCase()) < 0){
        return util.format("Teksti kodeeringu parameeter %s võib olla %s", "charEncoding", tools.joinAsString(allowedCharsets, ", ", " või ", defaultCharset, " (vaikimisi)"));
    }

    return true;
};

IPAYServletValidator.prototype.validate_feedBackUrl = function(){
    var value = (this.fields.feedBackUrl || "").toString();

    if(value && this.version == "002"){
        return util.format("Tagasisuunamise aadressi %s kasutamine ei ole protokolli versiooni %s puhul lubatud", "feedBackUrl", this.version);
    }

    if(!value && this.version == "004"){
        return util.format("Tagasisuunamise aadress %s kasutamine on protokolli versiooni %s puhul kohustuslik", "feedBackUrl", this.version);
    }

    return true;
};

IPAYServletValidator.prototype.validate_delivery = function(){
    var value = (this.fields.delivery || "").toString();

    if(value && this.version == "002"){
        return util.format("Transpordimeetodi %s kasutamine ei ole protokolli versiooni %s puhul lubatud", "delivery", this.version);
    }

    if(!value && this.version == "004"){
        return util.format("Transpordimeetodi %s kasutamine on protokolli versiooni %s puhul kohustuslik", "delivery", this.version);
    }

    if(value && ["S", "T"].indexOf(value.toUpperCase().trim()) < 0){
        return util.format('Transpordimeetodi %s väärtus on vigasel kujul, peab olema üks järgmistest: %s', "delivery", "\"S\" või \"T\"");
    }

    return true;
};

IPAYServlet.generateForm = function(payment, project, callback){
    tools.incrTransactionCounter(function(err, transactionId){
        if(err){
            return callback(err);
        }

        var paymentFields = {};
        payment.fields.forEach(function(field){
            paymentFields[field.key] = field.value;
        });

        var fields = {
                "action": "afb",
                "ver": paymentFields.ver,
                "id": paymentFields.id,
                "ecuno": paymentFields.ecuno,
                "receipt_no": payment.state == "PAYED" ? transactionId : "0",
                "eamount": paymentFields.eamount,
                "cur": paymentFields.cur,
                "respcode":  payment.state == "PAYED" ? "000" : "111",
                "datetime": paymentFields.datetime,
                "msgdata": payment.payment.senderName || "",
                "actiontext": payment.state == "PAYED" ? "OK, tehing autoriseeritud" : "Tehing katkestatud"
            };

        var transaction = new IPAYServlet(project.bank, fields, payment.charset);
        transaction.record = project;

        if(paymentFields.charEncoding){
            fields.charEncoding = paymentFields.charEncoding;
        }

        transaction.sign(function(err){
            if(err){
                return callback(err);
            }

            fields.auto = "Y";

            var method = "POST",
                payload = tools.stringifyQuery(fields, payment.charset),
                url = payment.state == "PAYED" ? payment.successTarget : payment.cancelTarget,
                hostname = (urllib.parse(url).hostname || "").toLowerCase().trim(),
                localhost = !!hostname.match(/^localhost|127\.0\.0\.1$/);

            if(payment.state == "PAYED" && !localhost){

                fetchUrl(url, {
                    method: method,
                    payload: payload ? payload : undefined,
                    agent: false,
                    maxResponseLength: 100 * 1024 * 1024,
                    timeout: 10000,
                    disableRedirects: true,
                    userAgent: config.hostname + " (automaatsed testmaksed)",
                    headers:{
                        "content-type": "application/x-www-form-urlencoded"
                    }
                }, function(err, meta, body){
                    if(err){
                        payment.autoResponse = {
                            status: false,
                            error: err.message
                        };
                    }else{
                        payment.autoResponse = {
                            statusCode: meta.status,
                            headers: meta.responseHeaders,
                            body: body && body.toString()
                        };
                    }
                    fields.auto = "N";
                    payment.responseFields = fields;
                    payment.responseHash = transaction.sourceHash;
                    payment.returnMethod = method;
                    callback(null, {method: method, url: url, payload: payload});
                });
            }else{
                if(localhost){
                    payment.autoResponse = {
                        status: false,
                        error: "localhost automaatpäringud ei ole lubatud"
                    };
                }
                fields.auto = "N";
                payment.responseFields = fields;
                payment.responseHash = transaction.sourceHash;
                payment.returnMethod = method;
                callback(null, {method: method, url: url, payload: payload});
            }
        });
    });
};
