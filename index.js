// Load ByteBuffer
var ByteBuffer;
if (typeof dcodeIO !== 'undefined') {
	ByteBuffer = dcodeIO.ByteBuffer;
} else {
	ByteBuffer = require('bytebuffer');
}

var DataType = {
	"End": 0x00, // end of an object or array
	"Object": 0x01, // read named values (names prefixed to value as varint-prefixed UTF-8 string) until you hit End
	"Array": 0x02, // read ordered values until you hit End
	"String": 0x03, // varint-prefixed UTF-8 string
	"Boolean": 0x04, // encoded as byte 0/1
	"Null": 0x05 // no actual data follows
	// TODO: Numbers
};

exports.decode = function(input) {
	var buffer = ByteBuffer.wrap(input, "binary", false);
	var currentKeyName;
	return readValue();

	function readValue(named) {
		var type = buffer.readUint8();
		var data, val;

		if (type == DataType.End) {
			return undefined; // special value to represent End; JSON can't encode undefined so this isn't a real value
		}

		if (named) {
			currentKeyName = buffer.readVString();
		}

		switch (type) {
			case DataType.Object:
				data = {};
				while ((val = readValue(true)) !== undefined) {
					data[currentKeyName] = val;
				}

				break;

			case DataType.Array:
				data = [];
				while ((val = readValue()) !== undefined) {
					data.push(val);
				}

				break;

			case DataType.String:
				data = buffer.readVString();
				break;

			case DataType.Boolean:
				data = !!buffer.readUint8();
				break;

			case DataType.Null:
				data = null;
				break;
		}

		return data;
	}
};
