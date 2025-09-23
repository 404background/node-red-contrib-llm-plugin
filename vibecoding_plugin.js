module.exports = function(RED) {
    console.log("VibeCoding plugin loaded on runtime");
    
    RED.plugins.registerPlugin("vibecoding", {
        type: "vibecoding",
        scripts: "vibecoding_plugin.html"
    });
    
    console.log("VibeCoding plugin registered successfully");
};
