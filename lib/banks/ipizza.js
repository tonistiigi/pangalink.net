var config = require("../../config/" + (process.env.NODE_ENV || "development") + ".json"),
    util = require("util"),
    banks = require("../banks"),
    tools = require("../tools"),
    db = require("../db"),
    crypto = require("crypto"),
    moment = require("moment"),
    fetchUrl = require("fetch").fetchUrl,
    urllib = require("url"),
    querystring = require("querystring"),
    IBAN = require('iban');

module.exports = IPizza;

function IPizza(bank, fields, charset){
    this.bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};
    this.fields = fields || {};

    this.normalizeValues();

    this.language = IPizza.detectLanguage(this.bank, this.fields);
    this.charset = charset || IPizza.detectCharset(this.bank, this.fields);
}

IPizza.detectLanguage = function(bank, fields){
    bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};

    var language = (fields.VK_LANG || "EST").toUpperCase();
    if(IPizza.languages.indexOf(language) < 0){
        language = IPizza.defaultLanguage;
    }

    return language;
};

IPizza.detectCharset = function(bank, fields){
    bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};

    var defaultCharset = bank.defaultCharset || config.ipizza.defaultCharset;

    return fields[bank.charset] || fields.VK_CHARSET || fields.VK_ENCODING || defaultCharset;
};

IPizza.allowedCurrencies = ["EUR", "LVL", "LTL"];
IPizza.languages = ["EST", "ENG", "RUS", "LAT", "LIT", "FIN", "SWE"];
IPizza.defaultLanguage = "EST";

IPizza.serviceTypes = {
    "1001": "PAYMENT",
    "1002": "PAYMENT",
    "4001": "IDENTIFICATION",
    "4002": "IDENTIFICATION"
};

IPizza.serviceFields = {

    // Maksekorraldus
    "1001": [
        "VK_SERVICE",
        "VK_VERSION",
        "VK_SND_ID",
        "VK_STAMP",
        "VK_AMOUNT",
        "VK_CURR",
        "VK_ACC",
        "VK_NAME",
        "VK_REF",
        "VK_MSG",
        "VK_MAC",
        "VK_RETURN",
        "VK_ENCODING",
        "VK_CHARSET",
        "VK_CANCEL",
        "VK_LANG"
    ],

    // Maksekorraldus ilma saajata (tuleneb lepingust)
    "1002": [
        "VK_SERVICE",
        "VK_VERSION",
        "VK_SND_ID",
        "VK_STAMP",
        "VK_AMOUNT",
        "VK_CURR",
        "VK_REF",
        "VK_MSG",
        "VK_MAC",
        "VK_RETURN",
        "VK_ENCODING",
        "VK_CHARSET",
        "VK_CANCEL",
        "VK_LANG"
    ]
};

IPizza.blockedFields = {
    "1002": [
        "VK_ACC",
        "VK_NAME"
    ]
};

IPizza.signatureOrder = {

    // Maksekorraldus
    "1001": [
        "VK_SERVICE",
        "VK_VERSION",
        "VK_SND_ID",
        "VK_STAMP",
        "VK_AMOUNT",
        "VK_CURR",
        "VK_ACC",
        "VK_NAME",
        "VK_REF",
        "VK_MSG"
    ],

    // Maksekorraldus ilma saajata (tuleneb lepingust)
    "1002": [
        "VK_SERVICE",
        "VK_VERSION",
        "VK_SND_ID",
        "VK_STAMP",
        "VK_AMOUNT",
        "VK_CURR",
        "VK_REF",
        "VK_MSG"
    ],

    // Õnnestunud tehing
    "1101": [
        "VK_SERVICE",
        "VK_VERSION",
        "VK_SND_ID",
        "VK_REC_ID",
        "VK_STAMP",
        "VK_T_NO",
        "VK_AMOUNT",
        "VK_CURR",
        "VK_REC_ACC",
        "VK_REC_NAME",
        "VK_SND_ACC",
        "VK_SND_NAME",
        "VK_REF",
        "VK_MSG",
        "VK_T_DATE"
    ],

    // Katkestatud tehing
    "1901":[
        "VK_SERVICE",
        "VK_VERSION",
        "VK_SND_ID",
        "VK_REC_ID",
        "VK_STAMP",
        "VK_REF",
        "VK_MSG"
    ],

    // Tagasi lükatud tehing
    "1902":[
        "VK_SERVICE",
        "VK_VERSION",
        "VK_SND_ID",
        "VK_REC_ID",
        "VK_STAMP",
        "VK_REF",
        "VK_MSG",
        "VK_ERROR_CODE"
    ]
};

// ++ kohustuslikud meetodid

IPizza.prototype.validateClient = function(callback){

    db.findOne("project", {uid: this.fields.VK_SND_ID}, (function(err, record){
        if(err){
            return callback(err);
        }

        if(!record){
            return callback(null, {success: false, errors: [
                {field: "VK_SND_ID", value: (this.fields.VK_SND_ID || "").toString(),
                error: "Sellise kliendi tunnusega makselahendust ei leitud. Juhul kui sertifikaat on aegunud, tuleks see uuesti genereerida"}], warnings: false});
        }

        if(this.bank.key != record.bank){
            return callback(null, {success: false, errors: [
                {field: "VK_SND_ID", value: (this.fields.VK_SND_ID || "").toString(),
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

IPizza.prototype.validateSignature = function(callback){
    this.calculateHash();

    tools.opensslVerify(
        this.sourceHash,
        this.fields.VK_MAC,
        this.record.userCertificate.certificate.toString("utf-8").trim(),
        this.charset,
        (function(err, success){
            if(err){
                return callback(err);
            }
            callback(null, {
                success: !!success,
                errors: !success?[
                        {field: "VK_MAC",
                        error: util.format("Allkirja parameetri %s valideerimine ebaõnnestus. Makse detailvaatest saad alla laadida PHP skripti, mis genereerib samade andmetega korrektse allkirja.", "VK_MAC")}
                    ]:false,
                warnings: false
            });
        }).bind(this));
};

IPizza.prototype.sign = function(callback){
    this.calculateHash();

    tools.opensslSign(
        this.sourceHash,
        this.record.bankCertificate.clientKey.toString("utf-8").trim(),
        this.charset, (function(err, signature){
            if(err){
                return callback(err);
            }
            this.fields.VK_MAC = signature;
            callback(null, true);
        }).bind(this));
};

IPizza.prototype.validateRequest = function(callback){
    var validator = new IPizzaValidator(this.bank, this.fields);
    validator.validateFields();
    this.errors = validator.errors;
    this.warnings = validator.warnings;

    callback(null, {
        success: !this.errors.length,
        errors: this.errors.length && this.errors || false,
        warnings: this.warnings.length && this.warnings || false
    });
};

IPizza.prototype.getUid = function(){
    return this.fields.VK_SND_ID;
};

IPizza.prototype.getCharset = function(){
    return this.charset;
};

IPizza.prototype.getLanguage = function(){
    return tools.languages[this.language] || "et";
};

IPizza.prototype.getSourceHash = function(){
    return this.sourceHash || false;
};

IPizza.prototype.getType = function(){
    return IPizza.serviceTypes[this.fields.VK_SERVICE] || false;
};

IPizza.prototype.getAmount = function(){
    return this.fields.VK_AMOUNT || "0";
};

IPizza.prototype.getReferenceCode = function(){
    return this.fields.VK_REF || false;
};

IPizza.prototype.getMessage = function(){
    return this.fields.VK_MSG || false;
};

IPizza.prototype.getCurrency = function(){
    return this.fields.VK_CURR || "EUR";
};

IPizza.prototype.getReceiverName = function(){
    if(this.fields.VK_SERVICE == "1002"){
        return this.record.ipizzaReceiverName || this.record.name;
    }else{
        return this.fields.VK_NAME || false;
    }
};

IPizza.prototype.getReceiverAccount = function(){
    if(this.fields.VK_SERVICE == "1002"){
        return this.record.ipizzaReceiverAccount || this.bank.accountNr || "";
    }else{
        return this.fields.VK_ACC || false;
    }
};

IPizza.prototype.editSenderName = function(){
    return true;
};

IPizza.prototype.showSenderName = function(){
    return false;
};

IPizza.prototype.editSenderAccount = function(){
    return true;
};

IPizza.prototype.showSenderAccount = function(){
    return false;
};

IPizza.prototype.showReceiverName = function(){
    return true;
};

IPizza.prototype.showReceiverAccount = function(){
    return true;
};

IPizza.prototype.getSuccessTarget = function(){
    return this.fields[this.bank.returnAddress] || "";
};

IPizza.prototype.getCancelTarget = function(){
    return this.fields[this.bank.cancelAddress] || this.fields[this.bank.returnAddress] || "";
};

IPizza.prototype.getRejectTarget = function(){
    return this.fields[this.bank.rejectAddress] || this.fields[this.bank.returnAddress] || "";
};

// -- kohustuslikud meetodid

IPizza.prototype.calculateHash = function(){
    var list = [];

    var utf8length = this.bank.utf8length || "symbols";

    if(this.fields.VK_SERVICE in IPizza.signatureOrder){

        IPizza.signatureOrder[this.fields.VK_SERVICE].forEach((function(vk){
            var val = this.fields[vk] || "",
                len = String(val).length;

            if(utf8length == "bytes" && this.charset.match(/^utf[\-_]?8$/i)){
                len = Buffer.byteLength(String(val), "utf-8");
            }

            list.push(String(len).lpad(3)+val);
        }).bind(this));

        this.sourceHash = list.join("");
    }else{
        this.sourceHash = false;
    }
};

IPizza.prototype.normalizeValues = function(){
    var keys = Object.keys(this.fields);

    for(var i = 0, len = keys.length; i < len; i++){
        if(this.fields[keys[i]] || this.fields[keys[i]]===0){
            this.fields[keys[i]] = (this.fields[keys[i]]).toString().trim();
        }else{
            this.fields[keys[i]] = "";
        }
    }
};

function IPizzaValidator(bank, fields){
    this.bank = (typeof bank == "string" ? banks[bank] || banks.ipizza || {} : bank) || {};
    this.fields = fields || {};

    this.errors = [];
    this.warnings = [];
}

IPizzaValidator.prototype.validateFields = function(){
    var service = (this.fields.VK_SERVICE || "").toString(),
        response = this.validate_VK_SERVICE();

    this.errors = [];
    this.warnings = [];

    if(typeof response == "string"){
        this.errors.push({field: "VK_SERVICE", value: service, error: response});
        return;
    }

    IPizza.serviceFields[service].forEach((function(field){
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
        }else if(this.bank.fieldRegex && 
          this.bank.fieldRegex[field] && 
          !value.match(new RegExp(this.bank.fieldRegex[field].re, this.bank.fieldRegex[field].flags))){
            this.errors.push({
                field: field, 
                value: value, 
                error: util.format("Väli %s sisaldab vigaseid sümboleid", field)
            });
        }
    }).bind(this));

    [].concat(IPizza.blockedFields[service] || []).forEach((function(field){
        if(this.fields[field]){
            this.warnings.push({
                field: field,
                value: (this.fields[field] || "").toString(),
                warning: util.format("Teenuse %s puhul ei ole välja %s kasutamine lubatud", service, field)
            });
        }
    }).bind(this));
};


IPizzaValidator.prototype.validate_VK_SERVICE = function(){
    var value = (this.fields.VK_SERVICE || "").toString();

    if(!value){
        return util.format("Teenuskoodi %s väärtust ei leitud", "VK_SERVICE");
    }

    if(!value.match(/^\d{4}$/)){
        return util.format("Teenuskoodi %s (\"%s\") väärtus peab olema neljakohaline number", "VK_SERVICE", value);
    }

    if(!IPizza.serviceFields[value] || (this.bank.allowedServices && this.bank.allowedServices.indexOf(value) < 0)){
        return util.format("Teenuskoodi %s (\"%s\") väärtus ei ole toetatud. Kasutada saab järgmisi väärtuseid: %s", "VK_SERVICE", value, (this.bank.allowedServices || Object.keys(IPizza.serviceFields)).join(", "));
    }

    return true;
};


IPizzaValidator.prototype.validate_VK_VERSION = function(){
    var value = (this.fields.VK_VERSION || "").toString();

    if(!value){
        return util.format("Krüptoalgoritmi %s väärtust ei leitud", "VK_SERVICE");
    }

    if(value != "008"){
        return util.format("Krüptoalgoritmi %s (\"%s\") väärtus peab olema %s", "VK_VERSION", value, "008");
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_SND_ID = function(){
    var value = (this.fields.VK_SND_ID || "").toString();

    if(!value){
        return util.format("Päringu koostaja tunnus %s peab olema määratud", "VK_SND_ID");
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_STAMP = function(){
    var value = (this.fields.VK_STAMP || "").toString();

    if(!value){
        return util.format("Päringu identifikaator %s peab olema määratud", "VK_STAMP");
    }

    if(!value.match(/^\d+$/)){
        return util.format("Päringu identifikaator %s (\"%s\") peab olema numbriline väärtus", "VK_STAMP", value);
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_AMOUNT = function(){
    var value = (this.fields.VK_AMOUNT || "").toString();

    if(!value){
        return util.format("Makse summa %s peab olema määratud", "VK_AMOUNT");
    }

    if(!value.match(/^\d{0,}(\.\d{1,2})?$/)){
        return util.format("Makse summa  %s (\"%s\") peab olema kujul \"123.45\"", "VK_AMOUNT", value);
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_CURR = function(){
    var value = (this.fields.VK_CURR || "").toString();

    if(!value){
        return util.format("Valuuta tähis %s peab olema määratud", "VK_CURR");
    }

    if(IPizza.allowedCurrencies.indexOf(value) < 0){
        return util.format("Valuuta tähis %s (\"%s\") peab olema üks järgmisest nimekirjast: ", "VK_CURR", value, IPizza.allowedCurrencies.join(", "));
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_ACC = function(){
    var value = (this.fields.VK_ACC || "").toString();

    if(!value){
        return util.format("Saaja konto number %s peab olema määratud", "VK_ACC");
    }

    if(!IBAN.isValid(value)){
        this.warnings.push({
            field: "VK_ACC",
            value: value,
            warning: util.format("Saaja konto number %s (\"%s\") ei vasta IBAN formaadile", "VK_ACC", value)
        });
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_NAME = function(){
    var value = (this.fields.VK_NAME || "").toString();

    if(!value){
        return util.format("Saaja nimi %s peab olema määratud", "VK_NAME");
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_REF = function(){
    var value = (this.fields.VK_REF || "").toString(),
        refNumber;

    if(!value){
        return true;
    }

    if(!value.match(/^\d{2,}$/)){
        return util.format("Viitenumber %s (\"%s\") peab olema vähemalt kahekohaline number", "VK_REF", value);
    }

    refNumber = tools.getReferenceCode(value.substr(0, value.length - 1));

    if(refNumber != value){
        return util.format("Viitenumber %s on vigane - oodati väärtust \"%s\", tegelik väärtus on \"%s\"", "VK_REF", refNumber, value);
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_MSG = function(){
    return true;
};

IPizzaValidator.prototype.validate_VK_RETURN = function(){
    var value = (this.fields.VK_RETURN || "").toString(),
        vkList = value && tools.validateReturnURL(value) || [];

    if(!value){
        return util.format("Tagasisuunamise aadress %s peab olema määratud", "VK_RETURN");
    }

    if(vkList.length){
        return util.format("Tagasisuunamise aadress %s ei tohi sisaldada VK_ algusega GET parameetreid. Hetkel kasutatud: %s", "VK_RETURN", vkList.join(", "));
    }

    if(!!this.bank.disallowQueryParams && (urllib.parse(value).query || "").length){
        this.warnings.push({
            field: "VK_RETURN",
            value: value,
            warning: util.format("%s ei võimalda kasutada tagasisuunamise aadressi %s milles sisaldub GET parameetreid", this.bank.name, "VK_RETURN")
        });
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_CANCEL = function(){
    var value = (this.fields.VK_CANCEL || "").toString(),
        vkList = value && tools.validateReturnURL(value) || [];

    if("VK_CANCEL" in this.fields && this.bank.cancelAddress != "VK_CANCEL"){
        this.warnings.push({
            field: "VK_CANCEL",
            value: value,
            warning: util.format("%s ei võimalda kasutada tagasisuunamise aadressi %s, selle asemel tuleks kasutada aadressi %s", this.bank.name, "VK_CANCEL", "VK_RETURN")
        });
    }

    if(value && vkList.length){
        return util.format("Tagasisuunamise aadress %s ei tohi sisaldada VK_ algusega GET parameetreid. Hetkel kasutatud: %s", "VK_CANCEL", vkList.join(", "));
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_ENCODING = function(){
    var value = (this.fields.VK_ENCODING || "").toString(),
        allowedCharsets = this.bank.allowedCharsets || [this.bank.defaultCharset || config.ipizza.defaultCharset],
        defaultCharset = this.bank.defaultCharset || config.ipizza.defaultCharset;

    if(!value && this.bank.charset == "VK_ENCODING" && this.bank.forceCharset){
        return this.bank.forceCharset;
    }

    if(!value){
        return true;
    }

    if(!this.bank.charset){
        return util.format("%s ei võimalda teksti kodeeringu seadmist parameetriga %s", this.bank.name, "VK_ENCODING");
    }

    if(this.bank.charset != "VK_ENCODING"){
        return util.format("%s nõuab %s parameetri asemel parameetrit %s", this.bank.name, "VK_ENCODING", this.bank.charset);
    }

    if(allowedCharsets.indexOf(value.toUpperCase()) < 0){
        return util.format("Teksti kodeeringu parameeter %s võib olla %s", "VK_ENCODING", tools.joinAsString(allowedCharsets, ", ", " või ", defaultCharset, " (vaikimisi)"));
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_CHARSET = function(){
    var value = (this.fields.VK_CHARSET || "").toString(),
        allowedCharsets = this.bank.allowedCharsets || ["ISO-8859-1"],
        defaultCharset = this.bank.defaultCharset || "ISO-8859-1";

    if(!value && this.bank.charset == "VK_CHARSET" && this.bank.forceCharset){
        return this.bank.forceCharset;
    }

    if(!value){
        return true;
    }

    if(!this.bank.charset){
        return util.format("%s ei võimalda teksti kodeeringu seadmist parameetriga %s", this.bank.name, "VK_CHARSET");
    }

    if(this.bank.charset != "VK_CHARSET"){
        return util.format("%s nõuab %s parameetri asemel parameetrit %s", this.bank.name, "VK_CHARSET", this.bank.charset);
    }

    if(allowedCharsets.indexOf(value.toUpperCase()) < 0){
        return util.format("Teksti kodeeringu parameeter %s (\"%s\") võib olla %s", "VK_CHARSET", value, tools.joinAsString(allowedCharsets, ", ", " või ", defaultCharset, " (vaikimisi)"));
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_LANG = function(){
    var value = (this.fields.VK_LANG|| "").toString();

    if(value && IPizza.languages.indexOf(value.toUpperCase().trim()) < 0){
        return util.format("Keele valiku parameeter %s (\"%s\") võib olla %s", "VK_LANG", value, tools.joinAsString(IPizza.languages, ", ", " või ", IPizza.defaultLanguage, " (vaikimisi)"));
    }

    return true;
};

IPizzaValidator.prototype.validate_VK_MAC = function(){
    var value = (this.fields.VK_MAC || "").toString();

    if(!value){
        return util.format("Allkirja parameeter %s peab olema määratud", "VK_MAC");
    }

    if(!value.match(/[^\-A-Za-z0-9+\/]+(={0,2})?$/)){
        return util.format("Allkirja parameeter %s peab olema BASE64 formaadis", "VK_MAC");
    }

    if(new Buffer(value, "base64").length % 128){
        return util.format("Allkirja parameeter %s on vale pikkusega, väärtus vastab %s bitisele võtmele, lubatud on 1024, 2048 ja 4096 bitised võtmed", "VK_MAC", new Buffer(value, "base64").length * 8);
    }

    return true;
};


IPizza.generateForm = function(payment, project, callback){
    tools.incrTransactionCounter(function(err, transactionId){
        if(err){
            return callback(err);
        }

        var paymentFields = {};
        payment.fields.forEach(function(field){
            paymentFields[field.key] = field.value;
        });

        var fields = {};
        if(payment.state == "PAYED"){
            fields = {
                "VK_SERVICE": "1101",
                "VK_VERSION": "008",
                "VK_SND_ID": banks[project.bank].id,
                "VK_REC_ID": paymentFields.VK_SND_ID,
                "VK_STAMP": paymentFields.VK_STAMP,
                "VK_T_NO": transactionId,
                "VK_AMOUNT": paymentFields.VK_AMOUNT,
                "VK_CURR":  paymentFields.VK_CURR,
                "VK_REC_ACC": paymentFields.VK_ACC || project.ipizzaReceiverAccount  || "",
                "VK_REC_NAME": paymentFields.VK_NAME || project.ipizzaReceiverName  || "",
                "VK_SND_ACC": payment.payment.senderAccount || "",
                "VK_SND_NAME": payment.payment.senderName || "",
                "VK_REF": paymentFields.VK_REF,
                "VK_MSG": paymentFields.VK_MSG,
                "VK_T_DATE": moment().format("DD.MM.YYYY")
            };
        }else if(payment.state == "REJECTED"){
            fields = {
                "VK_SERVICE": "1902",
                "VK_VERSION": "008",
                "VK_SND_ID": banks[project.bank].id,
                "VK_REC_ID": paymentFields.VK_SND_ID,
                "VK_STAMP": paymentFields.VK_STAMP,
                "VK_REF": paymentFields.VK_REF,
                "VK_MSG": paymentFields.VK_MSG,
                "VK_ERROR_CODE": "1234"
            };
        }else{
            fields = {
                "VK_SERVICE": "1901",
                "VK_VERSION": "008",
                "VK_SND_ID": banks[project.bank].id,
                "VK_REC_ID": paymentFields.VK_SND_ID,
                "VK_STAMP": paymentFields.VK_STAMP,
                "VK_REF": paymentFields.VK_REF,
                "VK_MSG": paymentFields.VK_MSG
            };
        }

        var transaction = new IPizza(project.bank, fields, payment.charset);
        transaction.record = project;

        if(paymentFields[banks[project.bank].charset]){
            fields[transaction.bank.charset] = paymentFields[transaction.bank.charset];
        }

        if(paymentFields.VK_LANG){
            fields.VK_LANG = paymentFields.VK_LANG;
        }

        transaction.sign(function(err){
            if(err){
                return callback(err);
            }

            fields.VK_AUTO = "Y";

            var method = transaction.bank.returnMethod || "POST",
                payload = tools.stringifyQuery(fields, payment.charset),
                url = payment.state == "PAYED" ? payment.successTarget : (payment.state == "REJECTED" ? payment.rejectTarget: payment.cancelTarget),
                resultUrl = url,
                hostname = (urllib.parse(url).hostname || "").toLowerCase().trim(),
                localhost = !!hostname.match(/^localhost|127\.0\.0\.1$/),
                headers = {};

            if(method == "GET"){
                url += (url.match(/\?/) ? "&" : "?") + payload;
                payload = false;
            }else if(method=="POST"){
                headers["content-type"] = "application/x-www-form-urlencoded";
            }

            if(payment.state == "PAYED" && !localhost){
                fetchUrl(url, {
                    method: method,
                    payload: payload ? payload : undefined,
                    agent: false,
                    maxResponseLength: 100 * 1024 * 1024,
                    timeout: 10000,
                    disableRedirects: true,
                    userAgent: config.hostname + " (automaatsed testmaksed)",
                    headers: headers
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
                    fields.VK_AUTO = "N";
                    method = "POST"; // force POST
                    
                    if(method == "GET"){
                        resultUrl += (resultUrl.match(/\?/) ? "&" : "?") + tools.stringifyQuery(fields, payment.charset);
                    }
                    payment.responseFields = fields;
                    payment.responseHash = transaction.sourceHash;
                    payment.returnMethod = method;
                    callback(null, {method: method, url: resultUrl, payload: payload});
                });
            }else{
                if(localhost){
                    payment.autoResponse = {
                        status: false,
                        error: "localhost automaatpäringud ei ole lubatud"
                    };
                }

                fields.VK_AUTO = "N";
                method = "POST"; // force POST
                
                if(method == "GET"){
                    resultUrl += (resultUrl.match(/\?/) ? "&" : "?") + tools.stringifyQuery(fields, payment.charset);
                }
                payment.responseFields = fields;
                payment.responseHash = transaction.sourceHash;
                payment.returnMethod = method;
                callback(null, {method: method, url: resultUrl, payload: payload});
            }
        });
    });
};
