var config = require("../config/" + (process.env.NODE_ENV || "development") + ".json"),
    ejs = require("ejs"),
    nodemailer = require("nodemailer"),
    transport = nodemailer.createTransport("SMTP", config.mail.smtp),
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

function sendRegistration(user){
    var contents = ejs.render(templates.registration, {
            hostname: config.hostname,
            title: config.title,
            user: user
        }),
        html = ejs.render(templates.mail, {
            hostname: config.hostname,
            title: config.title,
            twitter: config.twitter,
            header: util.format("%s – tere tulemast kasutama %s teenust", user.name, config.title),
            contents: contents
        }),
        mailOptions;

    mailOptions = {
        from: config.mail.from,
        to: "\"" + user.name.replace(/"/g, "") + "\" <" + user.id + ">",
        subject: util.format("%s – tere tulemast kasutama %s teenust", user.name, config.title),
        html: html
    };

    transport.sendMail(mailOptions);
}

function sendResetLink(user, resetToken){
    var contents = ejs.render(templates.resetLink, {
            hostname: config.hostname,
            title: config.title,
            resetToken: resetToken,
            user: user
        }),
        html = ejs.render(templates.mail, {
            hostname: config.hostname,
            title: config.title,
            twitter: config.twitter,
            header: util.format("%s – uuenda oma %s teenuse parooli", user.name, config.title),
            contents: contents
        }),
        mailOptions;

    mailOptions = {
        from: config.mail.from,
        to: "\"" + user.name.replace(/"/g, "") + "\" <" + user.id + ">",
        subject: util.format("%s – uuenda oma %s teenuse parooli", user.name, config.title),
        html: html
    };

    transport.sendMail(mailOptions);
}

function sendPassword(user, password){
    var contents = ejs.render(templates.sendPassword, {
            hostname: config.hostname,
            title: config.title,
            password: password,
            user: user
        }),
        html = ejs.render(templates.mail, {
            hostname: config.hostname,
            title: config.title,
            twitter: config.twitter,
            header: util.format("%s – sinu %s teenuse parool on uuendatud", user.name, config.title),
            contents: contents
        }),
        mailOptions;

    mailOptions = {
        from: config.mail.from,
        to: "\"" + user.name.replace(/"/g, "") + "\" <" + user.id + ">",
        subject: util.format("%s – sinu %s teenuse parool on uuendatud", user.name, config.title),
        html: html
    };

    transport.sendMail(mailOptions);
}
