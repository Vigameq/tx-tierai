from mangum import Mangum

from chat_api import app

handler = Mangum(app)
