"use strict";

var config = require("../config/" + (process.env.NODE_ENV || "development") + ".json"),
    ejs = require("ejs"),
    nodemailer = require("nodemailer"),
    mailType = config.mail.type || "SMTP",
    transport = nodemailer.createTransport(mailType, config.mail.hasOwnProperty(mailType.toLowerCase()) ? config.mail[mailType.toLowerCase()] : ""),
    fs = require("fs"),
    util = require("util"),
    templates = {
        mail: fs.readFileSync(__dirname + "/../www/views/mail/main.ejs", "utf-8"),
        registration: fs.readFileSync(__dirname + "/../www/views/mail/registration.ejs", "utf-8"),
        resetLink: fs.readFileSync(__dirname + "/../www/views/mail/resetlink.ejs", "utf-8"),
        sendPassword: fs.readFileSync(__dirname + "/../www/views/mail/sendpassword.ejs", "utf-8")
    };

module.exports.sendRegistration = sendRegistration;
module.exports.sendResetLink = sendResetLink;
module.exports.sendPassword = sendPassword;

function sendRegistration(req, user){
    var title = config.title || (config.hostname || (req && req.headers && req.headers.host) || "localhost").replace(/:\d+$/, "").toLowerCase().replace(/^./, function(s){
            return s.toUpperCase();
        }),
        hostname = (config.hostname || (req && req.headers && req.headers.host) || "localhost").replace(/:(80|443)$/, ""),
        contents = ejs.render(templates.registration, {
            proto: config.proto || "http",
            hostname: hostname,
            title: title,
            user: user,
            googleAnalyticsID: config.googleAnalyticsID
        }),
        html = ejs.render(templates.mail, {
            proto: config.proto || "http",
            hostname: hostname,
            title: title,
            twitter: config.twitter,
            header: util.format("%s – tere tulemast kasutama %s teenust", user.name, title),
            contents: contents
        }),
        mailOptions;

    mailOptions = {
        from: config.mail.from || "admin@" + hostname.replace(/:\d+$/, ""),
        to: "\"" + user.name.replace(/"/g, "") + "\" <" + user.id + ">",
        subject: util.format("%s – tere tulemast kasutama %s teenust", user.name, title),
        html: html
    };

    transport.sendMail(mailOptions);
}

function sendResetLink(req, user, resetToken){
    var title = config.title || (config.hostname || (req && req.headers && req.headers.host) || "localhost").replace(/:\d+$/, "").toLowerCase().replace(/^./, function(s){
            return s.toUpperCase();
        }),
        hostname = (config.hostname || (req && req.headers && req.headers.host) || "localhost").replace(/:(80|443)$/, ""),
        contents = ejs.render(templates.resetLink, {
            proto: config.proto || "http",
            hostname: hostname,
            title: title,
            resetToken: resetToken,
            user: user,
            googleAnalyticsID: config.googleAnalyticsID
        }),
        html = ejs.render(templates.mail, {
            proto: config.proto || "http",
            hostname: hostname,
            title: title,
            twitter: config.twitter,
            header: util.format("%s – uuenda oma %s teenuse parooli", user.name, title),
            contents: contents
        }),
        mailOptions;

    mailOptions = {
        from: config.mail.from || "admin@" + hostname.replace(/:\d+$/, ""),
        to: "\"" + user.name.replace(/"/g, "") + "\" <" + user.id + ">",
        subject: util.format("%s – uuenda oma %s teenuse parooli", user.name, title),
        html: html
    };

    transport.sendMail(mailOptions);
}

function sendPassword(req, user, password){
    var title = config.title || (config.hostname || (req && req.headers && req.headers.host) || "localhost").replace(/:\d+$/, "").toLowerCase().replace(/^./, function(s){
            return s.toUpperCase();
        }),
        hostname = (config.hostname || (req && req.headers && req.headers.host) || "localhost").replace(/:(80|443)$/, ""),
        contents = ejs.render(templates.sendPassword, {
            proto: config.proto || "http",
            hostname: hostname,
            title: title,
            password: password,
            user: user,
            googleAnalyticsID: config.googleAnalyticsID
        }),
        html = ejs.render(templates.mail, {
            proto: config.proto || "http",
            hostname: hostname,
            title: title,
            twitter: config.twitter,
            header: util.format("%s – sinu %s teenuse parool on uuendatud", user.name, title),
            contents: contents
        }),
        mailOptions;

    mailOptions = {
        from: config.mail.from || "admin@" + hostname.replace(/:\d+$/, ""),
        to: "\"" + user.name.replace(/"/g, "") + "\" <" + user.id + ">",
        subject: util.format("%s – sinu %s teenuse parool on uuendatud", user.name, title),
        html: html
    };

    transport.sendMail(mailOptions);
}
