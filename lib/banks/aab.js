var config = require("../../config/" + (process.env.NODE_ENV || "development") + ".json"),
    util = require("util"),
    banks = require("../banks"),
    tools = require("../tools"),
    db = require("../db"),
    crypto = require("crypto"),
    moment = require("moment"),
    fetchUrl = require("fetch").fetchUrl,
    urllib = require("url"),
    querystring = require("querystring");

module.exports = Aab;

function Aab(bank, fields, charset){
    this.bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};
    this.fields = fields || {};

    this.normalizeValues();

    this.version = Aab.detectVersion(this.bank, this.fields);

    this.language = Aab.detectLanguage(this.bank, this.fields);
    this.charset = charset || Aab.detectCharset(this.bank, this.fields);

    this.keyPrefix = "AAB_";

    this.uid = this.fields.SOLOPMT_RCV_ID || this.fields.RCV_ID;

    this.service = "PAYMENT-IN";

}

Aab.detectVersion = function(bank, fields){
    return fields.SOLOPMT_VERSION || fields.VERSION || "0002";
};

Aab.detectLanguage = function(bank, fields){
    bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};

    var language = (fields.SOLOPMT_LANGUAGE || fields.LANGUAGE || "4").trim();
    if(!Aab.languages[language]){
        return Aab.defaultLanguage;
    }else{
        return Aab.languages[language];
    }
};

Aab.detectCharset = function(bank, fields){
    bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};

    return bank.defaultCharset || config.aab.defaultCharset;
};

Aab.versions = ["0002"];

Aab.allowedCurrencies = ["EUR"];

Aab.languages = {
    "1": "FIN",
    "2": "SWE"
};

Aab.defaultLanguage = "FIN";

Aab.serviceFields = {

    // Maksekorraldus
    "PAYMENT-IN": [
        'VERSION',
        'STAMP',
        'RCV_ID',
        'RCV_ACCOUNT',
        'RCV_NAME',
        'LANGUAGE',
        'AMOUNT',
        'REF',
        'TAX_CODE',
        'DATE',
        'MSG',
        'RETURN',
        'CANCEL',
        'REJECT',
        'MAC',
        'CONFIRM',
        'KEYVERS',
        'CUR'
    ]
};

Aab.signatureOrder = {
    "0002":{
        "PAYMENT-IN": [
            'VERSION',
            'STAMP',
            'RCV_ID',
            'AMOUNT',
            'REF',
            'DATE',
            'CUR'
        ],
        "PAYMENT-OUT": [
            'RETURN-VERSION',
            'RETURN-STAMP',
            'RETURN-REF',
            'RETURN-PAID'
        ]
    }

};

// ++ kohustuslikud meetodid

Aab.prototype.validateClient = function(callback){
    db.findOne("project", {uid: this.uid}, (function(err, record){
        if(err){
            return callback(err);
        }
        if(!record){
            return callback(null, {success: false, errors: [
                {field: this.keyPrefix + "RCV_ID", value: (this.fields[this.keyPrefix + "RCV_ID"] || "").toString(),
                error: "Sellise kliendi tunnusega makselahendust ei leitud. Juhul kui sertifikaat on aegunud, tuleks see uuesti genereerida"}], warnings: false});
        }
        if(this.bank.key != record.bank){
            return callback(null, {success: false, errors: [
                {field: this.keyPrefix + "RCV_ID", value: (this.fields[this.keyPrefix + "RCV_ID"] || "").toString(),
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

Aab.prototype.validateSignature = function(callback){
    this.calculateHash();

    var mac;

    try{
        mac = crypto.createHash(this.record.aabAlgo).update(this.sourceHash).digest("hex").toUpperCase();
    }catch(E){
        return callback(E);
    }

    if(mac == this.fields[this.keyPrefix + "MAC"]){
        return callback(null, {success: true, errors: false, warnings: false});
    }

    callback(null, {
        success: false,
        errors: {field: this.fields[this.keyPrefix + "MAC"],
                error: util.format("Allkirja parameetri %s valideerimine ebaõnnestus. Makse detailvaatest saad alla laadida PHP skripti, mis genereerib samade andmetega korrektse allkirja.", this.keyPrefix + "MAC")},
        warnings: false
    });
};

Aab.prototype.sign = function(callback){
    this.calculateHash();

    try{
        this.fields[this.keyPrefix + "RETURN_MAC"] = crypto.createHash(this.record.aabAlgo).update(this.sourceHash).digest("hex").toUpperCase();
    }catch(E){
        return callback(E);
    }

    callback(null, true);
};

Aab.prototype.validateRequest = function(callback){

    this.errors = this.processFieldNames() || [];

    if(this.errors.length > 3){
        return callback(null, {
            success: !this.errors.length,
            errors: this.errors.length && this.errors || false,
            warnings: false
        });
    }

    var validator = new AabValidator(this.bank, this.fields, this.service, this.version, this.keyPrefix, this.record.aabAlgo);
    validator.validateFields();
    this.errors = this.errors.concat(validator.errors);
    this.warnings = validator.warnings;

    callback(null, {
        success: !this.errors.length,
        errors: this.errors.length && this.errors || false,
        warnings: this.warnings.length && this.warnings || false
    });
};

Aab.prototype.processFieldNames = function(){
    var errors = [];

    Aab.serviceFields[this.service].forEach((function(key){
        if(this.keyPrefix && key in this.fields){
            errors.push({field: key, value: (this.fields[key] || "").toString(), error: util.format("Parameetri %s nimi peab algama SOLOPMT_ prefiksiga", key)});
        }else if(!this.keyPrefix && "SOLOPMT_" + key in this.fields){
            errors.push({field: "SOLOPMT_" + key, value: (this.fields[key] || "").toString(), error: util.format("Parameetri %s nimi ei tohi sisaldada SOLOPMT_ prefiksit", "SOLOPMT_" + key)});
        }
    }).bind(this));

    return errors;
};

Aab.prototype.getUid = function(){
    return this.fields[this.keyPrefix + "RCV_ID"];
};

Aab.prototype.getCharset = function(){
    return this.charset;
};

Aab.prototype.getLanguage = function(){
    return tools.languages[this.language] || "et";
};

Aab.prototype.getSourceHash = function(){
    return this.sourceHash || false;
};

Aab.prototype.getType = function(){
    return "PAYMENT";
};

Aab.prototype.getAmount = function(){
    return this.fields[this.keyPrefix + "AMOUNT"] || "0";
};

Aab.prototype.getReferenceCode = function(){
    return this.fields[this.keyPrefix + "REF"] || false;
};

Aab.prototype.getMessage = function(){
    return this.fields[this.keyPrefix + "MSG"] || false;
};

Aab.prototype.getCurrency = function(){
    return this.fields[this.keyPrefix + "CUR"] || "EUR";
};

Aab.prototype.getReceiverName = function(){
    return this.fields[this.keyPrefix + "RCV_NAME"] || false;
};

Aab.prototype.getReceiverAccount = function(){
    return this.fields[this.keyPrefix + "RCV_ACCOUNT"] || false;
};

Aab.prototype.editSenderName = function(){
    return true;
};

Aab.prototype.showSenderName = function(){
    return false;
};

Aab.prototype.editSenderAccount = function(){
    return true;
};

Aab.prototype.showSenderAccount = function(){
    return false;
};

Aab.prototype.showReceiverName = function(){
    return !!this.getReceiverName();
};

Aab.prototype.showReceiverAccount = function(){
    return !!this.getReceiverAccount();
};

Aab.prototype.getSuccessTarget = function(){
    return this.fields[this.keyPrefix + this.bank.returnAddress] || "";
};

Aab.prototype.getCancelTarget = function(){
    return this.fields[this.keyPrefix + this.bank.cancelAddress] || this.fields[this.keyPrefix + this.bank.returnAddress] || "";
};

Aab.prototype.getRejectTarget = function(){
    return this.fields[this.keyPrefix + this.bank.rejectAddress] || this.fields[this.keyPrefix + this.bank.returnAddress] || "";
};

// -- kohustuslikud meetodid

Aab.prototype.calculateHash = function(){
    var list = [];

    if(!Aab.signatureOrder[this.version]){
        return;
    }

    if(!Aab.signatureOrder[this.version][this.service]){
        return;
    }

    Aab.signatureOrder[this.version][this.service].forEach((function(vk){
        var val = this.fields[this.keyPrefix + vk] || "";
        if(val){
            list.push(val);
        }
    }).bind(this));

    list.push(this.record.secret);
    list.push("");

    this.sourceHash = list.join("&");
};

Aab.prototype.normalizeValues = function(){
    var keys = Object.keys(this.fields);

    for(var i = 0, len = keys.length; i < len; i++){
        if(this.fields[keys[i]] || this.fields[keys[i]]===0){
            this.fields[keys[i]] = (this.fields[keys[i]]).toString().trim();
        }else{
            this.fields[keys[i]] = "";
        }
    }
};

Aab.prototype.getFields = function(){
    var fields = {};
    Aab.signatureOrder[this.version][this.service].forEach((function(key){
        if(this.fields[this.keyPrefix + key]){
            fields[this.keyPrefix + key] = this.fields[this.keyPrefix + key];
        }
    }).bind(this));

    if(this.fields[this.keyPrefix + "RETURN_MAC"]){
        fields[this.keyPrefix + "RETURN_MAC"] = this.fields[this.keyPrefix + "RETURN_MAC"];
    }


    return fields;
};

function AabValidator(bank, fields, service, version, keyPrefix, aabAlgo){
    this.bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};
    this.fields = fields || {};
    this.service = service || "PAYMENT-IN";
    this.version = version || "0002";
    this.keyPrefix = keyPrefix || "";
    this.aabAlgo = (aabAlgo || "md5").toUpperCase();

    this.errors = [];
    this.warnings = [];
}

AabValidator.prototype.validateFields = function(){
    this.errors = [];
    this.warnings = [];

    Aab.serviceFields[this.service].forEach((function(field){
        if(!this["validate_" + field]){
            return;
        }

        var response = this["validate_" + field](),
            value = (this.fields[this.keyPrefix + field] || "").toString();
            
        if(typeof response == "string"){
            this.errors.push({field: this.keyPrefix + field, value: (this.fields[this.keyPrefix + field] || "").toString(), error: response});
        }else if(this.bank.fieldLength && 
          this.bank.fieldLength[field] && 
          value.length > this.bank.fieldLength[field]){
            this.warnings.push({
                field: this.keyPrefix + field, 
                value: value, 
                warning: util.format("Välja %s pikkus on %s sümbolit, lubatud on %s", this.keyPrefix + field, value.length, this.bank.fieldLength[field])
            });
        }
    }).bind(this));
};


/* VERSION */
AabValidator.prototype.validate_VERSION = function(){
    var value = (this.fields[this.keyPrefix + "VERSION"] || "").toString();

    if(!value){
        return util.format("Teenuse versiooni %s väärtust ei leitud", this.keyPrefix + "VERSION");
    }

    if(!value.match(/^\d{4}$/)){
        return util.format("Teenuse versiooni %s (\"%s\") väärtus peab olema neljakohaline number", this.keyPrefix + "VERSION", value);
    }

    if(Aab.versions.indexOf(value) < 0){
        return util.format("Teenuskoodi %s (\"%s\") väärtus ei ole toetatud. Kasutada saab järgmisi väärtuseid: %s", this.keyPrefix + "VERSION", value, Aab.versions.join(", "));
    }

    return true;
};

/* MAC */
AabValidator.prototype.validate_MAC = function(){
    var value = (this.fields[this.keyPrefix + "MAC"] || "").toString();

    if(!value){
        return util.format("Allkirja parameeter %s peab olema määratud", this.keyPrefix + "MAC");
    }

    if(!value.match(/^[A-F0-9]+$/)){
        return util.format("Allkirja parameeter %s peab olema HEX formaadis ning sisaldama ainult suurtähti ning numbreid", this.keyPrefix + "MAC");
    }

    var len = value.length;

    if(this.aabAlgo == "md5" && len != 32){
        if(len == 40){
            return util.format("Allkirja parameeter %s peab olema MD5 formaadis, kuid tundub olevat SHA1 formaadis", this.keyPrefix + "MAC");
        }
    }

    if(this.aabAlgo == "sha1" && len != 40){
        if(len == 32){
            return util.format("Allkirja parameeter %s peab olema SHA1 formaadis, kuid tundub olevat MD5 formaadis", this.keyPrefix + "MAC");
        }
    }

    return true;
};

/* STAMP */
AabValidator.prototype.validate_STAMP = function(){
    var value = (this.fields[this.keyPrefix + "STAMP"] || "").toString();

    if(!value){
        return util.format("Maksekorralduse kood %s peab olema määratud", this.keyPrefix + "STAMP");
    }

    if(!value.match(/^\d+$/)){
        return util.format("Maksekorralduse kood %s peab olema numbriline väärtus", this.keyPrefix + "STAMP");
    }

    return true;
};

/* RCV_ID */
AabValidator.prototype.validate_RCV_ID = function(){
    var value = (this.fields[this.keyPrefix + "RCV_ID"] || "").toString();

    if(!value){
        return util.format("Päringu koostaja tunnus %s peab olema määratud", this.keyPrefix + "RCV_ID");
    }

    return true;
};

/* RCV_ACCOUNT */
/* RCV_NAME */

/* LANGUAGE */
AabValidator.prototype.validate_LANGUAGE = function(){
    var value = (this.fields[this.keyPrefix + "LANGUAGE"] || "").toString();

    if(!value){
        return util.format("Päringu koostaja tunnus %s peab olema määratud", this.keyPrefix + "LANGUAGE");
    }

    if(!value.match(/^\d$/)){
        return util.format("Keelevaliku tunnus %s peab olema ühekohaline number", this.keyPrefix + "LANGUAGE");
    }

    return true;
};

/* AMOUNT */
AabValidator.prototype.validate_AMOUNT = function(){
    var value = (this.fields[this.keyPrefix + "AMOUNT"] || "").toString();

    if(!value){
        return util.format("Makse summa %s peab olema määratud", this.keyPrefix + "AMOUNT");
    }

    if(!value.match(/^\d{0,}(\.\d{1,2})?$/)){
        return util.format("Makse summa %s peab olema kujul \"123.45\"", this.keyPrefix + "AMOUNT");
    }

    return true;
};

/* REF */
AabValidator.prototype.validate_REF = function(){
    var value = (this.fields[this.keyPrefix + "REF"] || "").toString(),
        refNumber;

    if(!value){
        return true;
    }

    if(!value.match(/^\d{2,}$/)){
        return util.format("Viitenumber %s (\"%s\") peab olema vähemalt kahekohaline number", this.keyPrefix + "REF", value);
    }

    refNumber = tools.getReferenceCode(value.substr(0, value.length - 1));

    if(refNumber != value){
        return util.format("Viitenumber %s on vigane - oodati väärtust \"%s\", tegelik väärtus on \"%s\"", this.keyPrefix + "REF", refNumber, value);
    }

    return true;
};

/* TAX_CODE */
AabValidator.prototype.validate_TAX_CODE = function(){
    var value = (this.fields[this.keyPrefix + "TAX_CODE"] || "").toString();

    if(!value && this.version == "0004"){
        return util.format("Maksu kood %s peab olema versiooni %s puhul määratud", this.keyPrefix + "TAX_CODE", "0004");
    }

    return true;
};

/* DATE */
AabValidator.prototype.validate_DATE = function(){
    var value = (this.fields[this.keyPrefix + "DATE"] || "").toString();

    if(!value){
        return util.format("Maksekorralduse tähtaeg %s peab olema määratud", this.keyPrefix + "DATE");
    }

    if(value.toUpperCase() != "EXPRESS"){
        return util.format("Maksekorralduse tähtaaja %s ainus lubatud väärtus on %s", this.keyPrefix + "DATE", "EXPRESS");
    }

    return true;
};

/* MSG */
AabValidator.prototype.validate_MSG = function(){
    var value = (this.fields[this.keyPrefix + "MSG"] || "").toString();

    if(!value){
        return util.format("Maksekorralduse selgitus %s peab olema määratud", this.keyPrefix + "MSG");
    }

    if(value.length > 210){
        return util.format("Maksekorralduse selgituse %s maksimaalne lubatud pikkus on %s sümbolit (hetkel on kasutatud %s)", this.keyPrefix + "MSG", 210, value.length);
    }

    return true;
};

/* RETURN */
AabValidator.prototype.validate_RETURN = function(){
    var value = (this.fields[this.keyPrefix + "RETURN"] || "").toString();

    if(!value){
        return util.format("Tagasisuunamise aadress %s peab olema määratud", this.keyPrefix + "RETURN");
    }

    if(!tools.validateUrl(value)){
        return util.format("Tagasisuunamise aadress %s peab olema korrektne URL", this.keyPrefix + "RETURN");
    }

    return true;
};

/* CANCEL */
AabValidator.prototype.validate_CANCEL = function(){
    var value = (this.fields[this.keyPrefix + "CANCEL"] || "").toString();

    if(!value){
        return util.format("Tagasisuunamise aadress %s peab olema määratud", this.keyPrefix + "CANCEL");
    }

    if(!tools.validateUrl(value)){
        return util.format("Tagasisuunamise aadress %s peab olema korrektne URL", this.keyPrefix + "CANCEL");
    }

    return true;
};

/* REJECT */
AabValidator.prototype.validate_REJECT = function(){
    var value = (this.fields[this.keyPrefix + "REJECT"] || "").toString();

    if(!value){
        return util.format("Tagasisuunamise aadress %s peab olema määratud", this.keyPrefix + "REJECT");
    }

    if(!tools.validateUrl(value)){
        return util.format("Tagasisuunamise aadress %s peab olema korrektne URL", this.keyPrefix + "REJECT");
    }

    return true;
};

/* CONFIRM */
AabValidator.prototype.validate_CONFIRM = function(){
    var value = (this.fields[this.keyPrefix + "CONFIRM"] || "").toString();

    if(!value){
        return util.format("Maksekorralduse kinnitus %s peab olema määratud", this.keyPrefix + "CONFIRM");
    }

    if(value.toUpperCase() != "YES"){
        return util.format("Maksekorralduse kinnituse %s ainus lubatud väärtus on %s, vastasel korral ei saa makse õnnestumisest teada", this.keyPrefix + "CONFIRM", "YES");
    }

    return true;
};


/* KEYVERS */
AabValidator.prototype.validate_KEYVERS = function(){
    var value = (this.fields[this.keyPrefix + "KEYVERS"] || "").toString();

    if(!value){
        return util.format("Võtme versioon %s peab olema määratud", this.keyPrefix + "KEYVERS");
    }

    if(!value.match(/^\d{4}$/)){
        return util.format("Võtme versioon %s peab olema neljakohaline number, näiteks \"0001\"", this.keyPrefix + "KEYVERS");
    }

    return true;
};

/* CUR */
AabValidator.prototype.validate_CUR = function(){
    var value = (this.fields[this.keyPrefix + "CUR"] || "").toString();

    if(!value){
        return util.format("Valuuta %s peab olema määratud", this.keyPrefix + "CUR");
    }

    if(Aab.allowedCurrencies.indexOf(value) < 0){
        return util.format("Valuuta %s on tundmatu väärtusega %s, kuid lubatud on %s", this.keyPrefix + "CUR", value, Aab.allowedCurrencies.join(", "));
    }

    return true;
};

Aab.genPaidCode = function(nr){
    var date = new Date(),
        year = date.getFullYear(),
        month = date.getMonth()+1,
        day = date.getDate(),
        stamp = String(year) + (month<10?"0":"") + month + (day<10?"0":"") + day;

    return "PEPM" + stamp + (nr && String(nr).lpad(12) || Math.floor(1+ Math.random()* 1000000000000));
};

Aab.generateForm = function(payment, project, callback){
    tools.incrTransactionCounter(function(err, transactionId){
        if(err){
            return callback(err);
        }

        var paymentFields = {};
        payment.fields.forEach(function(field){
            paymentFields[field.key] = field.value;
        });

        var transaction = new Aab(project.bank, paymentFields, payment.charset);
        transaction.service = "PAYMENT-OUT";
        transaction.keyPrefix = "AAB-";
        transaction.record = project;

        paymentFields[transaction.keyPrefix + "RETURN_VERSION"] = paymentFields[transaction.keyPrefix + "VERSION"];
        paymentFields[transaction.keyPrefix + "RETURN_STAMP"] = paymentFields[transaction.keyPrefix + "STAMP"];
        paymentFields[transaction.keyPrefix + "RETURN_REF"] = paymentFields[transaction.keyPrefix + "REF"];
        paymentFields[transaction.keyPrefix + "RETURN_PAYER_NAME"] = payment.payment.senderName || "";
        paymentFields[transaction.keyPrefix + "RETURN_PAYER_ACCOUNT"] = payment.payment.senderAccount || "";
        paymentFields[transaction.keyPrefix + "RETURN_TAX_CODE"] = paymentFields[transaction.keyPrefix + "TAX_CODE"];
        paymentFields[transaction.keyPrefix + "RETURN_MSG"] = paymentFields[transaction.keyPrefix + "MSG"];
        paymentFields[transaction.keyPrefix + "RETURN_PAID"] = payment.state == "PAYED" ? Aab.genPaidCode(transactionId) : "";

        transaction.sign(function(err){
            if(err){
                return callback(err);
            }

            var method = "GET",
                fields = transaction.getFields(),
                payload = tools.stringifyQuery(fields, payment.charset),
                url = payment.state == "PAYED" ? payment.successTarget : (payment.state == "REJECTED" ? payment.rejectTarget : payment.cancelTarget),
                hostname = (urllib.parse(url).hostname || "").toLowerCase().trim(),
                localhost = !!hostname.match(/^localhost|127\.0\.0\.1$/);

            url += (url.match(/\?/) ? "&" : "?") + payload;

            payment.responseFields = fields;
            payment.responseHash = transaction.sourceHash;
            payment.returnMethod = method;
            callback(null, {method: method, url: url, payload: payload});
        });
    });
};
