const EnergyUsage = require('../models/energyUsage');
const User = require('../models/user');
const geminiService = require('../services/geminiService');
const { calculateCost } = require('../utils/energyUtils');

// Controller functions
// Log energy usage
const logEnergyUsage = async (req, res) => {
  try {
    const { userId, deviceId, deviceName, deviceType, powerConsumption, duration, location } = req.body;
    
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const cost = calculateCost(powerConsumption, duration, user.ratePerKwh);

    const usage = new EnergyUsage({
      userId,
      deviceId,
      deviceName,
      deviceType,
      powerConsumption,
      duration,
      location,
      cost
    });

    await usage.save();
    res.status(201).json(usage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get energy usage data 
const getEnergyUsage = async (req, res) => {
  try {
    const { userId } = req.query;
    const { days = 7 } = req.query;
    
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - days);

    const usageData = await EnergyUsage.find({
      userId,
      timestamp: { $gte: dateThreshold }
    }).sort({ timestamp: -1 });

    res.json(usageData);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get usage summary
const getUsageSummary = async (req, res) => {
  try {
    const { userId } = req.query;
    const { days = 7 } = req.query;
    
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - days);

    const usageData = await EnergyUsage.aggregate([
      { $match: { userId, timestamp: { $gte: dateThreshold } } },
      { 
        $group: {
          _id: null,
          totalConsumption: { $sum: { $multiply: ["$powerConsumption", { $divide: ["$duration", 60] }] } },
          totalCost: { $sum: "$cost" },
          count: { $sum: 1 }
        }
      }
    ]);

    const byDevice = await EnergyUsage.aggregate([
      { $match: { userId, timestamp: { $gte: dateThreshold } } },
      { 
        $group: {
          _id: "$deviceType",
          consumption: { $sum: { $multiply: ["$powerConsumption", { $divide: ["$duration", 60] }] } },
          cost: { $sum: "$cost" },
          count: { $sum: 1 }
        }
      },
      { $sort: { consumption: -1 } }
    ]);

    const byLocation = await EnergyUsage.aggregate([
      { $match: { userId, timestamp: { $gte: dateThreshold } } },
      { 
        $group: {
          _id: "$location",
          consumption: { $sum: { $multiply: ["$powerConsumption", { $divide: ["$duration", 60] }] } },
          cost: { $sum: "$cost" },
          count: { $sum: 1 }
        }
      },
      { $sort: { consumption: -1 } }
    ]);

    res.json({
      total: usageData[0] || { totalConsumption: 0, totalCost: 0, count: 0 },
      byDevice,
      byLocation
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get energy analysis using Gemini AI
const getEnergyAnalysis = async (req, res) => {
  try {
    const { userId } = req.query;
    const { days = 7 } = req.query;
    
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - days);

    const usageData = await EnergyUsage.find({
      userId,
      timestamp: { $gte: dateThreshold }
    }).sort({ timestamp: 1 });

    const user = await User.findOne({ userId });
    
    if (!usageData.length) {
      return res.status(404).json({ message: 'No usage data found' });
    }

    const analysisPrompt = `Analyze this home energy usage data and provide insights:
User Profile:
- Household Size: ${user.householdSize}
- Home Size: ${user.homeSize} sq ft
- Energy Rate: $${user.ratePerKwh}/kWh

Usage Data (last ${days} days):
${usageData.map(entry => 
  `- ${entry.deviceName} (${entry.deviceType}): ${entry.powerConsumption}W for ${entry.duration} mins in ${entry.location}`
).join('\n')}

Provide a detailed analysis of usage patterns, potential wastage, and areas for improvement.`;

    const analysis = await geminiService.generateText(analysisPrompt);
    
    res.json({ analysis });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get personalized recommendations
const getRecommendations = async (req, res) => {
  try {
    const { userId } = req.query;
    const { days = 7 } = req.query;
    
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - days);

    const usageData = await EnergyUsage.find({
      userId,
      timestamp: { $gte: dateThreshold }
    }).sort({ timestamp: 1 });

    const user = await User.findOne({ userId });
    
    if (!usageData.length) {
      return res.status(404).json({ message: 'No usage data found' });
    }

    const recPrompt = `Based on this home energy usage data, provide personalized recommendations to save energy:
User Profile:
- Household Size: ${user.householdSize}
- Home Size: ${user.homeSize} sq ft
- Energy Rate: $${user.ratePerKwh}/kWh

Usage Data (last ${days} days):
${usageData.map(entry => 
  `- ${entry.deviceName} (${entry.deviceType}): ${entry.powerConsumption}W for ${entry.duration} mins in ${entry.location}`
).join('\n')}

Provide specific, actionable recommendations to reduce energy consumption. Prioritize recommendations that will have the biggest impact.`;

    const recommendations = await geminiService.generateText(recPrompt);
    
    res.json({ recommendations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get daily/weekly tip
const getDailyTip = async (req, res) => {
  try {
    const { userId } = req.query;
    
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const now = new Date();
    const lastAnalysis = user.lastAnalysisDate || new Date(0);
    const hoursSinceLastAnalysis = (now - lastAnalysis) / (1000 * 60 * 60);
    
    const shouldSendTip = user.preferences.receiveTips && 
      ((user.preferences.tipFrequency === 'daily' && hoursSinceLastAnalysis >= 24) ||
       (user.preferences.tipFrequency === 'weekly' && hoursSinceLastAnalysis >= 168));

    if (!shouldSendTip) {
      return res.json({ tip: null, message: 'No new tip needed at this time' });
    }

    const summary = await getUsageSummary({ query: { userId, days: 7 } }, { json: () => {} });
    
    const tipPrompt = `Generate a ${user.preferences.tipFrequency} energy-saving tip for this user based on their usage patterns:
User Profile:
- Household Size: ${user.householdSize}
- Home Size: ${user.homeSize} sq ft

Recent Usage Summary:
- Total Consumption: ${summary.total.totalConsumption.toFixed(2)} Wh
- Total Cost: $${summary.total.totalCost.toFixed(2)}
- Top Consuming Devices: ${summary.byDevice.slice(0, 3).map(d => `${d._id} (${d.consumption.toFixed(2)} Wh)`).join(', ')}

Create a concise, actionable tip (1-2 sentences) that would help this user save energy based on their usage patterns. Make it friendly and motivational.`;

    const tip = await geminiService.generateText(tipPrompt);
    
    user.lastAnalysisDate = now;
    await user.save();

    res.json({ tip });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// User management
const createUser = async (req, res) => {
  try {
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateUser = async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findOneAndUpdate({ userId }, req.body, { new: true });
    res.json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const getUser = async (req, res) => {
  try {
    const { userId } = req.query;
    const user = await User.findOne({ userId });
    res.json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Export all controller functions
module.exports = {
  logEnergyUsage,
  getEnergyUsage,
  getUsageSummary,
  getUsageTrends: async (req, res) => {
    res.status(501).json({ message: 'Not implemented yet' });
  },
  getEnergyAnalysis,
  getRecommendations,
  getDailyTip,
  createUser,
  updateUser,
  getUser
};
